---
title: Health, readiness, and shutdown
description: The liveness and readiness endpoints an orchestrator probes, what each one checks, what they are allowed to say, and how the server drains on SIGTERM.
sidebar:
  order: 7
---

Holotable exposes two probe endpoints. Neither requires authentication, and
neither is cached.

| Endpoint | Question | Cost |
| --- | --- | --- |
| `GET /api/health` | Is the process up? | No I/O |
| `GET /api/ready` | Should this instance be sent traffic? | One `SELECT 1`, one cached realm check |

## `GET /api/health` — liveness

Answers `200` whenever the process is serving, unconditionally:

```json
{ "status": "ok", "version": "0.1.0", "commit": "9f31c0ab12cd" }
```

`version` comes from `package.json` unless `APP_VERSION` overrides it, and
`commit` from `GIT_COMMIT`, reading `unknown` when nobody set it. The
Dockerfile takes it as a build argument:

```bash
docker build --build-arg GIT_COMMIT="$(git rev-parse HEAD)" -t holotable .
```

This is the endpoint the image's own `HEALTHCHECK` and the `app` service in
`docker-compose.yml` probe. Restarting a container because its database went
away is the wrong cure, so liveness never touches a dependency.

## `GET /api/ready` — readiness

Checks three dependencies and reports each one:

```json
{
  "status": "degraded",
  "checks": {
    "database": { "status": "ok" },
    "identityProvider": { "status": "failed", "reason": "http_503" },
    "aiProvider": { "status": "ok" }
  }
}
```

| `status` | HTTP | Meaning |
| --- | --- | --- |
| `ready` | 200 | Everything answers. |
| `degraded` | 200 | Serving, but an advisory dependency is down. |
| `not_ready` | 503 | The config store is unreachable. |
| `draining` | 503 | The process was asked to stop. |

### Which failure takes an instance out of rotation

Only the **config store**. Without it no page and no dashboard can be served,
so the instance should stop receiving traffic.

**Keycloak is advisory.** Sessions are first-party tokens, so a realm outage
stops new logins but leaves signed-in users working; failing readiness on every
instance would turn a login outage into a total one. The realm check is also
**cached** — one minute when it succeeds, five seconds when it fails — so a
probe loop does not hammer Keycloak.

**AI configuration is advisory**, and is configuration *only*: readiness checks
that `AI_MODEL` and the provider key are set and never makes a billed call. A
deployment that shipped without a key is degraded, not down — only generation
fails.

### What the body may contain

A failure is named by its dependency plus an error *code* — `ECONNREFUSED`,
`28P01`, `TIMEOUT`, `http_503` — or the name of an unset variable. Connection
strings, hostnames, URLs, and credentials never appear: the endpoint is
unauthenticated, so the body is treated as public. The rule lives in
`src/lib/readiness.ts` and is covered by `test/ready.test.ts`.

## Probing from Kubernetes

```yaml
livenessProbe:
  httpGet: { path: /api/health, port: 3000 }
  periodSeconds: 30
readinessProbe:
  httpGet: { path: /api/ready, port: 3000 }
  periodSeconds: 10
```

Readiness fails as soon as the process begins draining, which is what removes
a terminating pod from its Service before the server stops accepting work.

## Graceful shutdown

`SIGTERM` (a rolling deploy, a pod eviction, `docker stop`) starts a drain
rather than an exit. The sequence lives in `src/lib/shutdown.ts`:

1. **The drain flag is set**, synchronously. `/api/ready` answers `503` with
   `"status": "draining"` from that moment, and the load balancer stops
   routing here. `/api/health` stays `200` — a process on its way out is not
   broken, and restarting it is the wrong cure.
2. **Every poller stops** (`stopAllPollers`), so no new metric query is issued.
3. **Open SSE streams get a terminal frame** — an SSE `retry:` hint plus a
   named `draining` event — and are closed. `EventSource` honours `retry:`
   natively, so subscribers come back to a healthy instance; the delay is
   randomized per stream (2–10s) so a terminating instance does not send all
   of its viewers back at the same moment, to the replacement that is least
   able to absorb them.
4. **In-flight queries are awaited.** Metric queries open a short-lived client
   each and are counted explicitly; config-store work is awaited by
   `pool.end()`, which waits for every checked-out client to be released.
5. **The process exits 0**, whether it drained or ran out of budget. A slow
   query should not make an orchestrator report a failed shutdown.

The whole sequence is bounded by `SHUTDOWN_GRACE_MS` (default `10000`). A
second `SIGTERM` or `SIGINT` skips the remaining wait and exits immediately.

The HTTP listener is deliberately left open during the drain: readiness has
already taken the instance out of rotation, so a request that still arrives is
served rather than refused.

### Give the drain room to finish

The orchestrator's kill timeout must exceed `SHUTDOWN_GRACE_MS`, or the
process is killed mid-drain:

```yaml
# Kubernetes
terminationGracePeriodSeconds: 20
```

```yaml
# docker-compose.yml, already set on the `app` service
stop_grace_period: 20s
```

### `NEXT_MANUAL_SIG_HANDLE`

Next installs its own `SIGTERM`/`SIGINT` handlers, which exit `143` without
draining and would win the race. `NEXT_MANUAL_SIG_HANDLE=true` hands the
signals to the app instead; it is set in the `start` script and in the runtime
image, and a deployment that starts the server some other way must set it too.
It has no effect under `next dev`, where Next does not hand signals over.
