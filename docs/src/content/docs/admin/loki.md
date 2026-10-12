---
title: Loki endpoints
description: Running Holotable against Grafana Loki or Grafana Cloud Logs — the URL allowlist, auth and secret references, the limits, and shipping logs with Grafana Alloy.
---

What a Loki source is, and how a LogQL panel runs, is in
[Loki sources](/concepts/loki-sources/). This page is what an operator sets up
so source admins can register one. Most of it is the
[Prometheus page](/admin/prometheus/) again, because the two kinds share one
HTTP client: the same URL rules, the same auth modes, the same secret
references.

## The URL allowlist

A Loki source's URL is typed by a source admin, and the server sends requests
there, carrying the source's credential when it has one. So it is held to the
rules a model base URL is (`src/lib/ai/base-url.ts`): `https` only; no private,
loopback, link-local or otherwise non-public address, checked on every address
the name resolves to and again on the address each connection uses; no
credentials in the URL; no redirects followed.

`SOURCE_URL_ALLOWLIST` is the operator's exception, one list for Prometheus and
Loki sources alike: host names, addresses and CIDR ranges a source URL may
reach although they are not public, and over plain `http`. An in-cluster Loki
needs it:

```bash
SOURCE_URL_ALLOWLIST=prometheus-operated.monitoring.svc.cluster.local,loki-gateway.logging.svc.cluster.local
```

It is one list for every workspace: a source admin in any workspace may point a
source at what it names. An endpoint that must stay one tenant's should require
auth and be reached through a `secret_ref` only that workspace is granted. An
entry that does not parse refuses the boot. With the Helm chart's network
policy on, the pod's egress rule should name the same endpoint, as
`deploy/helm/holotable/examples/values-prometheus-source.yaml` shows for
Prometheus.

The compose stack sets `SOURCE_URL_ALLOWLIST=prometheus,loki`, which admits its
own Prometheus and the `logs` profile's Loki from inside the network, and
`.env.example` adds `localhost` for a server on the host.

## Auth and secret references

| `auth` | The server sends | Resolved from |
| --- | --- | --- |
| `none` | no `Authorization` header | nothing; the source names no `secret_ref` |
| `bearer` | `Authorization: Bearer <token>` | `<REF>_TOKEN` |
| `basic` | HTTP basic auth | `<REF>_USERNAME` and `<REF>_PASSWORD` |

The ref is granted to workspaces by `SOURCE_SECRET_REFS` and read from
`SOURCE_SECRETS_DIR` files or the environment, exactly as a Prometheus or
database source's is. See
[Source secret references](/admin/secret-references/#prometheus-sources). The
credential is never stored, never sent to the browser, and redacted from every
log line. Grafana Cloud Logs takes `basic`, with the stack's user id as the
user name and an access-policy token with `logs:read` as the password: give it
that scope and no other.

`none` is for an endpoint the network, not a credential, protects. It needs
its host on `SOURCE_URL_ALLOWLIST`, which is the operator's decision that the
endpoint may be read without one.

## Compatibility

Holotable speaks the Loki HTTP API, and every request is a GET: queries go to
`/loki/api/v1/query` and `/loki/api/v1/query_range`, discovery to
`/loki/api/v1/labels` and `/loki/api/v1/label/<name>/values`, and the
connection test reads `/ready` and `/loki/api/v1/status/buildinfo`. A real Loki
answers 405 to a POST on the label routes, which is why nothing is POSTed.

| Endpoint | Notes |
| --- | --- |
| Grafana Loki 2.9 and 3.x | Everything. The dev and e2e stacks run 3.7. |
| Grafana Cloud Logs | Point the URL at the stack's Loki host, such as `https://logs-prod-012.grafana.net`, with `basic` auth. |
| A gateway in front of a multi-tenant Loki | One source per tenant, behind a proxy that sets the tenant header (below). |

**Out of scope.** Holotable does not send `X-Scope-OrgID` or any other
multi-tenant request header, and does not present a client certificate (mTLS),
as for Prometheus. Put a proxy that sets them in front of the endpoint, one
source per tenant, and allowlist the proxy. Tailing (`/loki/api/v1/tail`), the
pattern and detected-field endpoints, and the volume and index-stats endpoints
are not used either: panels poll, and the catalog is labels.

## Limits

| Variable | Default | What it bounds |
| --- | --- | --- |
| `LOKI_MAX_ENTRIES` | `1000` | Lines one log query asks for and keeps, newest first: the `limit` sent on every log query, inside `MAX_QUERY_ROWS` and a logs panel's own `limit`. A full answer is badged as cut. |
| `LOKI_MAX_SERIES` | `100` | Series in one metric query's result. More is refused with a message that says to aggregate. |
| `LOGQL_MAX_RANGE` | `PROMQL_MAX_RANGE` (`7d`) | The longest `[range]` or `offset` an expression may write, and how far back a label-values variable looks. |
| `PROMQL_MAX_POINTS` | `1000` | Points per series in a metric range query; the step is the window divided by this, as for PromQL. |
| `PROMETHEUS_MIN_STEP_MS` | `15000` | The finest step of a metric range query. |
| `PROMETHEUS_DISCOVERY_WINDOW` | `1h` | How far back discovery, refresh and the test look for labels and values: one discovery window for both HTTP kinds. |
| `QUERY_TIMEOUT_SECONDS` | `20` | The deadline on the whole exchange. |
| `MAX_RESULT_BYTES` | `4 MiB` | Bytes read from one answer before the server stops. |

Loki's own limits still apply on its side (`max_entries_limit_per_query`,
`max_query_series`, `max_query_length`), and the smaller of the two wins. Keep
Loki's at or above Holotable's, or a panel is refused by the endpoint rather
than badged by the server.

## Shipping logs with Grafana Alloy

Which shipper fills a Loki is not Holotable's concern, but the label set it
writes is the allowlist a source admin will pick from, so it is worth choosing
on purpose: a few low-cardinality labels (`app`, `env`, `namespace`), never a
request id or a user. The compose stack's `logs` profile uses Grafana Alloy,
reading every container of the compose project through the Docker socket:

```hcl
discovery.docker "compose" {
  host = "unix:///var/run/docker.sock"
  filter {
    name   = "label"
    values = ["com.docker.compose.project=holotable"]
  }
}

discovery.relabel "compose" {
  targets = []

  rule {
    source_labels = ["__meta_docker_container_label_com_docker_compose_service"]
    target_label  = "app"
  }
  rule {
    source_labels = ["__meta_docker_container_name"]
    regex         = "/(.*)"
    target_label  = "container"
  }
  rule {
    target_label = "env"
    replacement  = "dev"
  }
}

loki.source.docker "compose" {
  host          = "unix:///var/run/docker.sock"
  targets       = discovery.docker.compose.targets
  relabel_rules = discovery.relabel.compose.rules
  forward_to    = [loki.write.local.receiver]
}

loki.write "local" {
  endpoint {
    url = "http://loki:3100/loki/api/v1/push"
  }
}
```

On Kubernetes the same shape reads pods instead (`discovery.kubernetes` and
`loki.source.kubernetes`), with `app` from the pod's `app.kubernetes.io/name`
label and `namespace` from its namespace.

Holotable's own log lines are one JSON object each (`LOG_FORMAT=json`, the
production default; see [Logging](/operations/logging/)), so a LogQL panel
parses them with `| json` and no shipper-side processing is needed. A
`guard.refused` line carries the `language` and `reason` of every query a
guard refused, and `request.completed`, `request.rejected` and
`request.failed` carry each API request's `route`, `status` and `durationMs`.

## Metrics

The LogQL guard's refusals are counted in
`holotable_logql_validation_rejections_total{reason}`, beside the SQL and
PromQL guards', and query latency, outcome and row counts are in
`holotable_query_duration_seconds` and `holotable_query_rows` with the source as
a label, whatever its kind. See [Prometheus metrics](/operations/metrics/).
