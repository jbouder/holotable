---
title: Deploying on Kubernetes
description: The Helm chart, the three ways to supply credentials, how a rolling update stays quiet, and why the chart is single-replica on purpose.
sidebar:
  order: 11
---

The chart lives in `deploy/helm/holotable/` and deploys three things: the app,
a schema-migration Job that runs before it, and the objects around them —
Service, Ingress, ConfigMap, ServiceAccount, and optional HPA, PodDisruptionBudget,
and NetworkPolicy.

It deploys neither PostgreSQL/TimescaleDB nor Keycloak. Both are external, and
the chart expects to be told where they are.

```bash
helm install holotable deploy/helm/holotable \
  -f deploy/helm/holotable/examples/values-kubernetes-secret.yaml
```

The chart's own [README](https://github.com/jbouder/holotable/tree/main/deploy/helm/holotable)
documents every value. This page is the reasoning behind the ones that are not
obvious.

## Images

No image is published yet
([#97](https://github.com/jbouder/holotable/issues/97)). Build both targets of
the repository `Dockerfile` and push them to a registry the cluster can pull
from:

```bash
docker build -t <registry>/holotable:0.1.0 \
  --build-arg GIT_COMMIT="$(git rev-parse HEAD)" .
docker build -t <registry>/holotable:0.1.0-migrate --target migrate .
```

`runtime` is the Next.js standalone server; `migrate` is the one-shot job image
that carries `tsx`, `scripts/`, and `migrations/`. Point `image.repository` and
`migrations.image.repository` at them, or pin `image.digest` — a digest wins
over a tag, the same way the Dockerfile pins its own base.

## Credentials never enter the chart

Everything under `config` is rendered into a **ConfigMap**, which is clear text
to anyone who can read the namespace. Credentials go in a Secret, loaded with
`envFrom`, so its keys are environment variable names verbatim: `SESSION_SECRET`,
`DATABASE_URL`, `OIDC_CLIENT_SECRET`, the provider API key, and one
`<REF>_USERNAME` / `<REF>_PASSWORD` pair per source
[`secret_ref`](/operations/secret-references/).

The chart enforces this rather than asking: a key under `config` named like a
credential — `DATABASE_URL`, `TIMESCALEDB_URL`, or anything ending in
`_SECRET`, `_TOKEN`, `_PASSWORD`, `_API_KEY`, `_KEY` — **fails the render** with
a message naming the value and where it belongs. CI proves that guard still
fires.

Three wirings, each a runnable values file under
`deploy/helm/holotable/examples/`:

| Wiring | File | When |
| --- | --- | --- |
| A Kubernetes Secret you create | `values-kubernetes-secret.yaml` | No secret manager |
| Vault, through the Agent injector | `values-vault-agent.yaml` | Vault, no operator |
| Secrets Store CSI driver | `values-secrets-store-csi.yaml` | AWS/Azure/GCP/Vault CSI |

The Vault one is the only one that needs a trick. The Agent injector writes a
*file*; the app reads its environment. The injected template therefore renders
`export` lines and `app.command` wraps the entrypoint:

```yaml
app:
  command: ["/bin/sh", "-c", ". /vault/secrets/env && exec node server.js"]
```

`exec` matters: without it the shell stays PID 1's child, swallows `SIGTERM`,
and the drain below never starts. If you run the Vault Secrets Operator
instead, it syncs a Vault path into a Kubernetes Secret and this becomes the
first wiring, with no wrapper at all.

:::caution
`secrets.create` will make the Secret from your values. It is off by default
because those values then live in your values file, in `helm get values`, and
in whatever stores your release history — and because it is rendered as a hook
(see below), so `helm uninstall` leaves it behind. Use it on a scratch cluster.
:::

## A rolling update nobody notices

Four settings are one mechanism:

| Setting | Does |
| --- | --- |
| `readinessProbe` → `/api/ready` | Fails the instant the process gets `SIGTERM`, which removes the pod from the Service |
| `livenessProbe` → `/api/health` | No I/O, stays `200` while draining — a pod on its way out is not broken |
| `preStop` sleep | Gives kube-proxy and the ingress controller time to stop routing here *before* `SIGTERM` |
| `maxUnavailable: 0` | The new pod is ready before the old one is asked to stop |

`terminationGracePeriodSeconds` is derived from `app.shutdownGraceMs` plus the
preStop sleep plus five seconds of slack. Set it yourself and the chart checks
it: a value below the drain budget **fails the render**, because the kubelet
would `SIGKILL` the server while it is still awaiting in-flight queries. That is
the one way to turn the graceful shutdown back into an abrupt one, and it is
silent when it happens.

What the app does with that budget — the readiness flip, the SSE `retry:` hint
with its randomized delay, the awaited queries, the pool close — is in
[Health, readiness, and shutdown](/operations/health-checks/).

## Migrations gate the rollout

`migrations.enabled` (default `true`) runs the `migrate` image as a
`pre-install,pre-upgrade` hook. A failed migration **aborts the release**: the
Deployment is never touched, and the previous version keeps serving rather than
meeting a schema it cannot use.

A hook rather than an init container, because an init container runs once per
pod and would race itself across a rollout. The runner takes an advisory lock
anyway, so concurrent runs serialize — see
[Database migrations](/operations/migrations/) — but the ordering that matters
is that the schema is in place before any new code serves a request.

The Job carries its own ConfigMap and ServiceAccount, and a chart-managed
Secret is rendered as a hook too. That is not decoration: a hook runs *before*
the release's ordinary resources exist, so a Job pointing at the app's
ServiceAccount or ConfigMap fails a **first install** with `serviceaccount "…"
not found`, and works on every upgrade after it. Both copies are weighted ahead
of the Job and removed again when the hook phase succeeds; the data comes from
the same template helper as the app's, so they cannot drift. Give the Job a
Vault role or a workload identity through
`migrations.serviceAccount.annotations`.

## Argo CD

`deploy/argocd/holotable-application.yaml` is a reference `Application`. Argo CD
reads Helm hooks and runs the migration Job as a PreSync resource, so the same
manifest gates a GitOps sync with nothing extra to configure.

Keep credentials out of it exactly as above: the Application names a Secret,
and something else — a sealed secret, the Vault Secrets Operator, the CSI
driver — puts it in the namespace.

## One replica, on purpose

Keep `replicaCount` at `1` and `autoscaling.enabled` at `false`.

The poller lives in the Node process and is keyed by dashboard in a
process-local map. A second replica polls every dashboard it has a subscriber
for a second time: the load on TimescaleDB multiplies by the replica count, and
two people looking at one dashboard can see different data because each replica
keeps its own cursor. [Scaling and the poller](/architecture/scaling/) has the
detail and the issues that fix it —
[#40](https://github.com/jbouder/holotable/issues/40) first.

The HPA and PodDisruptionBudget templates exist because a chart without them is
incomplete, not because scaling out works today. `NOTES.txt` repeats the
warning after any install that raises the replica count.

:::note
A `PodDisruptionBudget` with `minAvailable: 1` over a single replica blocks
voluntary disruption entirely — `kubectl drain` on that node waits forever. Use
`maxUnavailable: 1` if you want one at all.
:::

## Metrics

[`/api/metrics`](/operations/metrics/) answers `404` until `METRICS_TOKEN` or
`METRICS_ALLOWED_CIDRS` is set. Put the token in the Secret with the rest of the
credentials and point the scraper at the pod:

```yaml
podAnnotations:
  prometheus.io/scrape: "true"
  prometheus.io/path: /api/metrics
  prometheus.io/port: "3000"
```

A Prometheus Operator `ServiceMonitor` is not part of the chart; add one beside
the release with `bearerTokenSecret` pointing at the same key.

## The pod is locked down by default

Non-root (uid/gid 1001, the user the image creates), `readOnlyRootFilesystem`,
every capability dropped, no privilege escalation, `seccompProfile:
RuntimeDefault`, and no ServiceAccount token mounted — the app calls no
Kubernetes API. Two `emptyDir` volumes, `/tmp` and `/app/.next/cache`, are the
only writable paths.

`networkPolicy.enabled` adds a default-deny policy in both directions. It is off
by default because the right peers are cluster-specific, and an egress policy
with no rules would cut the app off from its own database. Worth turning on: the
app's egress is small and known — config store, metrics store, Keycloak, model
provider — so a policy makes "generated SQL cannot call somewhere else" true at
the network layer too.
