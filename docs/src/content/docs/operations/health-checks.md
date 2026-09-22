---
title: Health and readiness
description: The liveness and readiness endpoints an orchestrator probes, what each one checks, and what they are allowed to say.
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
