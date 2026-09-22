# Holotable Helm chart

Deploys the Holotable app, its schema-migration Job, and the wiring a cluster
needs around them: probes on the real health endpoints, a grace period sized
against the app's own drain budget, a non-root read-only pod, and three ways to
supply credentials without any of them touching this chart.

It does **not** deploy PostgreSQL/TimescaleDB or Keycloak. Both are external
dependencies, and the chart expects to be told where they are.

```bash
helm install holotable deploy/helm/holotable \
  -f deploy/helm/holotable/examples/values-kubernetes-secret.yaml
```

## Before you install

1. **Images.** Nothing is published yet
   ([#97](https://github.com/jbouder/holotable/issues/97)), so build and push
   both targets of the repository `Dockerfile` and point `image.repository` and
   `migrations.image.repository` at your registry:

   ```bash
   docker build -t <registry>/holotable:0.1.0 \
     --build-arg GIT_COMMIT="$(git rev-parse HEAD)" .
   docker build -t <registry>/holotable:0.1.0-migrate --target migrate .
   ```

2. **A database.** A PostgreSQL 16 with TimescaleDB, reachable from the
   cluster. The migration Job creates the schema on first install.

3. **A Keycloak realm.** OIDC is the only way to sign in; there is no local
   login. See [Keycloak setup](https://holotable-docs.pages.dev/operations/keycloak/).

4. **A Secret** holding the credential environment. The chart never generates
   one for you — see below.

## Credentials

The app reads every credential from its **environment**, and the chart loads
that environment with `envFrom`, so the keys of your Secret are environment
variable names verbatim:

| Key | What it is |
| --- | --- |
| `SESSION_SECRET` | 32+ random characters; signs session cookies |
| `DATABASE_URL` | `postgresql://…` for the config store |
| `OIDC_CLIENT_SECRET` | The Keycloak client secret |
| `OPENAI_API_KEY` / `AI_GATEWAY_API_KEY` | The model provider key |
| `METRICS_TOKEN` | Bearer token that opens `/api/metrics` |
| `<REF>_USERNAME`, `<REF>_PASSWORD` | One pair per data source `secret_ref` |

The last row is the one that is easy to miss. A source stores the *name*
`TS_METRICS` and nothing else; the server resolves `TS_METRICS_USERNAME` and
`TS_METRICS_PASSWORD` from its own environment when it executes a query. A
source whose family is missing saves fine and fails on **Test**. See
[Source secret references](https://holotable-docs.pages.dev/operations/secret-references/).

Three wirings, each a runnable values file in [`examples/`](examples):

| Wiring | File | When |
| --- | --- | --- |
| A Kubernetes Secret you create | `values-kubernetes-secret.yaml` | No secret manager |
| Vault, through the Agent injector | `values-vault-agent.yaml` | Vault, no operator |
| Secrets Store CSI driver | `values-secrets-store-csi.yaml` | AWS/Azure/GCP/Vault CSI |

`secrets.create` exists as a fourth option and is off for a reason: it puts
credentials in your values file, and therefore in `helm get values` and in
whatever stores your release history. It is also rendered as a hook (see
below), so `helm uninstall` leaves it behind. Use it for a scratch cluster, not
for anything real.

**`config` is not a place for credentials.** Everything under `config` is
rendered into a ConfigMap in clear text. The chart refuses to render if a key
there is named like a credential (`DATABASE_URL`, `TIMESCALEDB_URL`, or
anything ending in `_SECRET`, `_TOKEN`, `_PASSWORD`, `_API_KEY`, `_KEY`).

## Probes, rollout, and shutdown

The three settings below are one mechanism, not three independent knobs.

- `readinessProbe` hits `/api/ready`, which fails **the moment the process gets
  SIGTERM** — that is what takes a terminating pod out of the Service.
  `failureThreshold: 1` makes it immediate.
- `livenessProbe` hits `/api/health`, which does no I/O and answers `200`
  whenever the process is serving, including while it drains. A pod is not
  broken because its database went away, and restarting it is the wrong cure.
- `preStop` sleeps `app.preStopSleepSeconds` before SIGTERM, because endpoint
  removal is asynchronous: kube-proxy and your ingress controller need a moment
  to stop sending work here.
- `terminationGracePeriodSeconds` is derived — `app.shutdownGraceMs` rounded up
  to seconds, plus the preStop sleep, plus 5 seconds of slack. Set it yourself
  and the chart checks it: a value below the drain budget fails the render
  rather than letting the kubelet SIGKILL a server mid-drain.
- `strategy.rollingUpdate.maxUnavailable: 0` means the new pod is ready before
  the old one is asked to stop, so a rolling update never empties the Service.

Together: no request is routed to a pod that is going away, open SSE streams
get a reconnect hint with a randomized delay, in-flight queries finish, and the
process exits 0. [Health, readiness, and
shutdown](https://holotable-docs.pages.dev/operations/health-checks/) has the
full sequence.

## Migrations

`migrations.enabled` (default `true`) runs the `migrate` image as a
`pre-install,pre-upgrade` hook. A failed migration **aborts the release**, so
the previous version keeps serving rather than meeting a schema it cannot use.
Argo CD reads the Helm hook and runs the same Job as PreSync.

The runner takes a Postgres advisory lock, so two Jobs from one rollout
serialize instead of racing. Logs of a failed Job stay until the next release
replaces it (`helm.sh/hook-delete-policy: before-hook-creation`).

### Why the Job has its own ConfigMap and ServiceAccount

A hook runs *before* the release's ordinary resources exist. A first install
whose Job referenced the app's ServiceAccount or ConfigMap fails with
`serviceaccount "…" not found` or `configmap "…" not found` — and only on a
first install, which makes it the kind of bug that is found by the person
evaluating the chart rather than by the person who wrote it.

So the Job gets hook copies of both, weighted ten ahead of it and removed again
once the hook phase succeeds. The data comes from the same template helper as
the app's ConfigMap, so the two cannot drift. A chart-managed Secret
(`secrets.create`) is a hook for the same reason, minus the `hook-succeeded`
delete policy — the app reads it for as long as it runs.

If the Job needs an identity of its own — a Vault role, a cloud workload
identity — annotate `migrations.serviceAccount.annotations`; the
`values-vault-agent.yaml` example does exactly that.

Set `migrations.enabled: false` if you apply migrations from a pipeline
instead; `NOTES.txt` then prints the manual command.

## Replicas

**Keep `replicaCount` at 1 and `autoscaling.enabled` at `false`.**

The poller lives in the Node process and is keyed by dashboard in a
process-local map. A second replica polls every dashboard it has a subscriber
for a second time: TimescaleDB sees the load multiplied by the replica count,
and two viewers of one dashboard can drift apart because each replica keeps its
own cursor.

The HPA and PDB templates are here because a chart without them is incomplete,
not because scaling out is supported today. That waits on
[#40](https://github.com/jbouder/holotable/issues/40) (topology),
[#41](https://github.com/jbouder/holotable/issues/41) (delta fan-out), and
[#42](https://github.com/jbouder/holotable/issues/42) (a distributed lease).
`NOTES.txt` says so again after any install that raises the replica count.

A `PodDisruptionBudget` with `minAvailable: 1` over a single replica blocks
`kubectl drain` forever. Use `maxUnavailable: 1` if you want one at all.

## Metrics

`/api/metrics` answers `404` until `METRICS_TOKEN` or `METRICS_ALLOWED_CIDRS`
is set; both set means both are required. Put the token in the Secret and point
your scraper at the pod:

```yaml
podAnnotations:
  prometheus.io/scrape: "true"
  prometheus.io/path: /api/metrics
  prometheus.io/port: "3000"
```

A Prometheus Operator `ServiceMonitor` is not part of this chart — add one
alongside the release, with `bearerTokenSecret` pointing at the same Secret key.

## Values

### Workload

| Key | Default | Description |
| --- | --- | --- |
| `replicaCount` | `1` | App replicas. See [Replicas](#replicas) before raising it. |
| `image.repository` | `ghcr.io/jbouder/holotable` | Image built from the `runtime` target. |
| `image.tag` | `""` | Defaults to the chart's `appVersion`. |
| `image.digest` | `""` | `sha256:…`; wins over `tag`. |
| `image.pullPolicy` | `IfNotPresent` | |
| `imagePullSecrets` | `[]` | Applied to the Deployment and the migration Job. |
| `nameOverride` / `fullnameOverride` | `""` | Resource naming. |
| `resources` | 100m/256Mi requests, 1Gi memory limit | No CPU limit on purpose: throttling a Node process mid-render costs more than it saves. |
| `nodeSelector`, `tolerations`, `affinity`, `topologySpreadConstraints`, `priorityClassName` | empty | Standard scheduling controls. |
| `podAnnotations`, `podLabels` | `{}` | Merged onto the pod template. |

### Application

| Key | Default | Description |
| --- | --- | --- |
| `app.port` | `3000` | Container port; also sets `PORT`. |
| `app.shutdownGraceMs` | `10000` | `SHUTDOWN_GRACE_MS`. Sizes the grace period. |
| `app.preStopSleepSeconds` | `5` | preStop sleep before SIGTERM. |
| `app.command` / `app.args` | `[]` | Entrypoint override. Needed only to source an injected environment file (see the Vault example). |
| `config` | `{}` | Non-secret environment, rendered into a ConfigMap. Any variable from the [configuration reference](https://holotable-docs.pages.dev/reference/configuration/). |
| `extraEnv` | `[]` | Raw `env` entries, for a single key from a Secret via `valueFrom`. |
| `extraEnvFrom` | `[]` | Extra `envFrom` sources, by name. |
| `extraVolumes` / `extraVolumeMounts` | `[]` | Applied to the app **and** the migration Job. |
| `lifecycle` | `{}` | Replaces the whole lifecycle block. On 1.30+, `{preStop: {sleep: {seconds: 5}}}`. |
| `terminationGracePeriodSeconds` | `""` | Derived when empty; validated when set. |

### Credentials

| Key | Default | Description |
| --- | --- | --- |
| `secrets.existingSecret` | `""` | Name of the Secret loaded with `envFrom`. |
| `secrets.create` | `false` | Let the chart create it from `secrets.values`. Discouraged. |
| `secrets.values` | `{}` | Contents of that Secret. Only read when `create` is true. |

### Migrations

| Key | Default | Description |
| --- | --- | --- |
| `migrations.enabled` | `true` | Run the pre-install/pre-upgrade hook. |
| `migrations.image.repository` | `ghcr.io/jbouder/holotable` | Image built from the `migrate` target. |
| `migrations.image.tag` | `""` | Defaults to `<appVersion>-migrate`. |
| `migrations.image.digest` | `""` | Wins over `tag`. |
| `migrations.hookWeight` | `-5` | Ordering against other hooks. The Job's ConfigMap, ServiceAccount, and any chart-managed Secret are weighted ten ahead of it. |
| `migrations.command` / `.args` | `[]` | Entrypoint override for the Job. |
| `migrations.serviceAccount.create` | `true` | Create the Job's own ServiceAccount, as a hook. |
| `migrations.serviceAccount.name` | `""` | Defaults to `<fullname>-migrate`. |
| `migrations.serviceAccount.annotations` | `{}` | The Vault role or workload identity the Job runs as. |
| `migrations.backoffLimit` | `1` | Job retries. |
| `migrations.activeDeadlineSeconds` | `600` | Also bounds a wait on the advisory lock. |
| `migrations.ttlSecondsAfterFinished` | `null` | Null keeps a failed Job and its logs. |
| `migrations.resources` | 50m/128Mi requests | |
| `migrations.podAnnotations`, `.nodeSelector`, `.tolerations`, `.affinity` | empty | Job-only overrides. |

### Networking

| Key | Default | Description |
| --- | --- | --- |
| `service.type` | `ClusterIP` | |
| `service.port` | `80` | Service port; the target is always the container's `http` port. |
| `service.nodePort` | `null` | Only with `type: NodePort`. |
| `service.annotations` | `{}` | |
| `ingress.enabled` | `false` | |
| `ingress.className` | `""` | |
| `ingress.annotations` | `{}` | |
| `ingress.hosts` | one example host | `[{host, paths: [{path, pathType}]}]`. |
| `ingress.tls` | `[]` | Standard `spec.tls`. |
| `networkPolicy.enabled` | `false` | Default-deny both directions. |
| `networkPolicy.ingressFrom` | `[]` | Peers allowed to reach the app port. Empty denies everything. |
| `networkPolicy.egressTo` | `[]` | Raw egress rules for Postgres, Keycloak, and the model provider. |
| `networkPolicy.allowDNS` | `true` | Egress to `kube-dns`. |

### Security and availability

| Key | Default | Description |
| --- | --- | --- |
| `podSecurityContext` | non-root uid/gid 1001, `fsGroup` 1001, `seccompProfile: RuntimeDefault` | The image's own user. |
| `securityContext` | no privilege escalation, read-only root, all capabilities dropped | `/tmp` and `/app/.next/cache` are emptyDirs; nothing else is written. |
| `serviceAccount.create` | `true` | |
| `serviceAccount.name` | `""` | Defaults to the release name. |
| `serviceAccount.annotations` | `{}` | Vault role or cloud workload identity. |
| `serviceAccount.automountServiceAccountToken` | `false` | The app calls no Kubernetes API. |
| `autoscaling.enabled` | `false` | See [Replicas](#replicas). |
| `autoscaling.minReplicas` / `maxReplicas` | `1` / `3` | |
| `autoscaling.targetCPUUtilizationPercentage` | `75` | |
| `autoscaling.targetMemoryUtilizationPercentage` | `null` | Omitted from the HPA when null. |
| `autoscaling.behavior` | `{}` | Raw `spec.behavior`. |
| `podDisruptionBudget.enabled` | `false` | |
| `podDisruptionBudget.minAvailable` | `1` | Mutually exclusive with `maxUnavailable`. |
| `podDisruptionBudget.maxUnavailable` | `null` | |

### Probes

`livenessProbe`, `readinessProbe`, and `startupProbe` are passed through
verbatim, so any probe field works. Set one to `null` to drop it. The defaults
are in [Probes, rollout, and
shutdown](#probes-rollout-and-shutdown); do not point liveness at `/api/ready`,
which fails whenever the config store is unreachable and would turn a database
blip into a restart loop.

## Upgrading

```bash
helm upgrade holotable deploy/helm/holotable -f my-values.yaml --wait
```

`--wait` is worth it: without it the command returns before the rollout is
healthy, and a bad image looks like a successful upgrade. The migration hook
runs before the Deployment is touched either way.

A change to `config` rolls the pods: the Deployment carries a checksum of the
rendered ConfigMap, because `envFrom` is read once at container start. A change
to a Secret the chart does not manage does **not** roll them — restart the
Deployment yourself after rotating a credential.

## Uninstalling

```bash
helm uninstall holotable
```

The database is external and survives. So does the Secret, if you created it.
