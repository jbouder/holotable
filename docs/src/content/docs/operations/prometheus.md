---
title: Prometheus sources
description: Running Holotable against Prometheus, Thanos, Mimir or VictoriaMetrics — the URL allowlist, auth and secret references, compatibility, and sizing.
---

What a Prometheus source is, and how a PromQL panel runs, is in
[Prometheus sources](/concepts/prometheus-sources/). This page is what an
operator sets up so source admins can register one.

## The URL allowlist

A Prometheus source's URL is typed by a source admin, and the server sends
requests there, carrying the source's credential when it has one. So a source
URL is held to the rules a model base URL is (`src/lib/ai/base-url.ts`):

- `https` only;
- no private, loopback, link-local or otherwise non-public address, checked on
  every address the name resolves to, and again on the address each connection
  actually uses (`src/lib/ai/guarded-fetch.ts`), so a DNS answer cannot change
  between the check and the request;
- no credentials in the URL, and redirects are never followed.

`SOURCE_URL_ALLOWLIST` is the operator's exception: host names, addresses and
CIDR ranges that a source URL may reach although they are not public, and over
plain `http`. An in-cluster Prometheus needs it:

```bash
SOURCE_URL_ALLOWLIST=prometheus-operated.monitoring.svc.cluster.local
```

It is one list for every workspace. A source admin in any workspace may point a
source at what it names, so an endpoint that must stay one tenant's should
require auth and be reached through a `secret_ref` only that workspace is
granted. An entry that does not parse refuses the boot, so a typo cannot widen
it. With the Helm chart's network policy on, the pod's egress rule should name
the same endpoint: `deploy/helm/holotable/examples/values-prometheus-source.yaml`
has both.

## Auth and secret references

| `auth` | The server sends | Resolved from |
| --- | --- | --- |
| `none` | no `Authorization` header | nothing; the source names no `secret_ref` |
| `bearer` | `Authorization: Bearer <token>` | `<REF>_TOKEN` |
| `basic` | HTTP basic auth | `<REF>_USERNAME` and `<REF>_PASSWORD` |

The ref is granted to workspaces by `SOURCE_SECRET_REFS` and read from
`SOURCE_SECRETS_DIR` files or the environment, exactly as a database source's
is. See [Source secret references](/operations/secret-references/#prometheus-sources).
The credential is never stored, never sent to the browser, and redacted from
every log line.

`none` is for an endpoint that the network, not a credential, protects. It
needs its host on `SOURCE_URL_ALLOWLIST`, which is the operator's decision that
the endpoint may be read without one.

## Compatibility

Holotable speaks the Prometheus HTTP API. Queries are `POST`ed forms to
`/api/v1/query` and `/api/v1/query_range`. Label values come from
`/api/v1/label/<name>/values`, discovery from `/api/v1/metadata`,
`/api/v1/labels` and `/api/v1/series`, and the connection test reads
`/-/ready`, `/api/v1/status/buildinfo` and `/api/v1/status/flags`.

| Endpoint | Notes |
| --- | --- |
| Prometheus 2.x and 3.x | Everything. |
| Thanos Query | Everything. The test names it from the build info. |
| Grafana Mimir | Point the URL at the Prometheus API prefix, such as `https://mimir.example.com/prometheus`. Tenancy by `X-Scope-OrgID` is not supported; use one source per tenant behind a proxy that sets it. |
| VictoriaMetrics | Point the URL at the Prometheus-compatible path. Without metadata, discovery offers metric names only, with type `unknown`. |

**The write surface.** The connection test reads the endpoint's flags and
reports whether `web.enable-admin-api`, `web.enable-remote-write-receiver` or
`web.enable-otlp-receiver` is on. Holotable never writes to an endpoint, and
the guard cannot express a write, but a credential that can reach an admin API
can do more than read. The test is a finding to act on, not a block: give the
source a read-only token, or put the endpoint behind a proxy that only passes
the query API. An endpoint that does not publish its flags reads as "unknown".

## Sizing

| Variable | Default | What it bounds |
| --- | --- | --- |
| `PROMQL_MAX_POINTS` | `1000` | Points per series in a range query. The step is the window divided by this. |
| `PROMETHEUS_MIN_STEP_MS` | `15000` | The finest step, whatever the window. Keep it at or above the scrape interval. |
| `PROMETHEUS_MAX_SERIES` | `100` | Series in one result. More is refused with a message that says to aggregate. |
| `PROMQL_MAX_RANGE` | `7d` | The longest range, subquery or `offset` an expression may write, and how far back a label-values variable looks. |
| `PROMETHEUS_DISCOVERY_WINDOW` | `1h` | How far back discovery, refresh and the test look for a metric's series. |
| `QUERY_TIMEOUT_SECONDS` | `20` | The deadline the endpoint is given (`timeout`), and the request's own. |
| `MAX_RESULT_BYTES` | `4 MiB` | Bytes read from one answer before the server stops. |

A dashboard of twelve range panels over a day asks for at most twelve
thousand points per series, per poll, and the pollers share one request per
dashboard and set of picks, however many people are watching. A larger
`PROMQL_MAX_POINTS` buys resolution with endpoint load; the 15-second floor
keeps a short window from asking for more points than the endpoint scraped.

## Metrics

The PromQL guard's refusals are counted in
`holotable_promql_validation_rejections_total{reason}`, beside the SQL guard's,
and query latency, outcome and row counts are in `holotable_query_duration_seconds`
and `holotable_query_rows` with the source as a label, whatever its kind. See
[Prometheus metrics](/operations/metrics/).
