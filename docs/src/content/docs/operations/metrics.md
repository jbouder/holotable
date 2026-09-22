---
title: Prometheus metrics
description: The /api/metrics scrape endpoint — what it exports, how access is gated, and how label cardinality is kept bounded.
sidebar:
  order: 8
---

Holotable exports Prometheus metrics from `GET /api/metrics`. Everything it
exposes is state the server already keeps in memory — how long a poller tick
takes, how long a metrics query runs, how many browsers are attached to a
dashboard, what the model costs, what the SQL guard rejects — so a scrape does
no I/O and needs no timeout of its own.

The endpoint is **closed until you configure it**. With neither
`METRICS_TOKEN` nor `METRICS_ALLOWED_CIDRS` set it answers `404`.

## Access

A scraper holds no session cookie, so `/api/metrics` sits outside the normal
authorization path and has a gate of its own
([`src/lib/metrics-access.ts`](https://github.com/jbouder/holotable/blob/main/src/lib/metrics-access.ts)).

| `METRICS_TOKEN` | `METRICS_ALLOWED_CIDRS` | Requirement |
| --- | --- | --- |
| unset | unset | `404` — the endpoint is disabled |
| set | unset | `Authorization: Bearer <token>` |
| unset | set | The request's source address is in the list |
| set | set | **Both** |

Set both and they are ANDed, never ORed. That is deliberate: the address check
reads `X-Forwarded-For`, and a header a client can write must never be able to
stand in for the token.

`METRICS_ALLOWED_CIDRS` is a comma- or space-separated list of IPv4/IPv6
addresses and CIDR ranges — `10.0.0.0/8, 192.168.1.5, fd00::/8, ::1`. An
IPv4-mapped IPv6 address (`::ffff:10.0.0.1`, how a dual-stack listener reports
an IPv4 peer) is folded to IPv4, so one entry covers both forms. An entry that
does not parse stops the server from booting rather than silently narrowing the
list.

The address itself is taken from the **last** `X-Forwarded-For` hop, falling
back to `X-Real-IP`. A proxy either overwrites that header with the peer it
observed or appends that peer to whatever arrived, so in both cases anything a
client injected sits to its left. If the app is reachable without a proxy in
front of it, the address check means nothing — use `METRICS_TOKEN`.

```bash
# Generate a token
openssl rand -hex 32

# Scrape it
curl -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:3000/api/metrics
```

Startup validation warns in production when a CIDR allowlist is configured
without a token, and when a token is shorter than 24 characters. See
[Startup validation](/operations/startup-validation/).

## What is exported

All application metrics carry the `holotable_` prefix, as do the default
process and Node.js collectors (`holotable_process_cpu_seconds_total`,
`holotable_nodejs_heap_size_used_bytes`, …).

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `holotable_poller_tick_duration_seconds` | histogram | `dashboard` | Wall time of one poller tick, across every panel on the dashboard |
| `holotable_query_duration_seconds` | histogram | `source`, `outcome` | One guarded query, including connect and rollback. `outcome` is `ok` or `error` |
| `holotable_query_rows` | histogram | `source` | Rows returned by one guarded query. Not observed for a failed statement |
| `holotable_sse_subscribers` | gauge | `dashboard` | Browsers attached to a dashboard's stream **on this instance** |
| `holotable_pollers_active` | gauge | — | Pollers running on this instance |
| `holotable_llm_tokens_total` | counter | `workspace`, `model`, `direction` | Tokens billed to a workspace. `direction` is `input` or `output` |
| `holotable_llm_requests_total` | counter | `route`, `outcome` | Model requests at the admission gate. `outcome` is `admitted`, `rate_limited` or `over_budget` |
| `holotable_sql_validation_rejections_total` | counter | `reason` | Statements refused by the SQL guard |

`reason` comes from a fixed enum, not the error message: `empty`, `structure`,
`comment`, `keyword`, `function`, `time`, `catalog`. The message names the
offending table or function and is therefore attacker-influenced text; only the
reason is safe as a label.

Two of these are per-instance, not per-deployment. `holotable_sse_subscribers`
and `holotable_pollers_active` count what *this* process is doing, because the
poller is per-process — see [Scaling and the
poller](/architecture/scaling/). Sum across instances; do not expect one
instance to know the whole picture. A distributed poller lease
([#42](https://github.com/jbouder/holotable/issues/42)) will add a metric for
lease ownership.

## Label cardinality

A metric label that can take unboundedly many values turns a scrape into an
outage, so:

- No user-supplied text is ever a label. Not SQL, not a prompt, not an error
  message, not a panel title.
- `dashboard`, `source`, `workspace` and `model` are opaque ids passed through
  a cap of 500 distinct values per label. Everything past the cap is reported
  as `other`, so the scrape stays a fixed size however many ids the process has
  seen.
- A dashboard's series is dropped when its poller stops, so an instance does
  not accumulate one gauge per dashboard that ever existed.

## Scraping from Docker Compose

`docker-compose.yml` ships a Prometheus service behind the `metrics` profile,
so it stays out of the default `docker compose up`. Set `METRICS_TOKEN` in your
`.env` first — the scrape config reads the same value, and without it every
target shows as down:

```bash
echo "METRICS_TOKEN=$(openssl rand -hex 32)" >> .env
docker compose up -d
docker compose --profile metrics up -d prometheus
```

Prometheus is then on `http://localhost:9090`, scraping `app:3000/api/metrics`
every 15s with 6 hours of retention.

If `METRICS_TOKEN` is unset, compose falls back to a checked-in local default so
that the self-monitoring collector below still works out of the box. That
default guards a scrape on the compose network and nothing else; set a real one
for anything reachable from outside it.

## Holotable watching itself

The default `docker compose up` also runs `self-metrics`, which scrapes this
endpoint into a TimescaleDB hypertable and registers it as an ordinary source,
so the shipped **Holotable self-monitoring** dashboard is guarded SQL over the
metrics above. It does not go through Prometheus — Holotable reads SQL, not
PromQL. See [Demo data](/getting-started/demo-data/) for the collector, the
table, and the end-to-end smoke test built on it.

A Kubernetes deployment scrapes the same endpoint; put the token in a Secret
and reference it from the `ServiceMonitor`'s `bearerTokenSecret`, or restrict
the port and use `METRICS_ALLOWED_CIDRS` instead.
