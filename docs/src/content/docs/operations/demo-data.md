---
title: Demo data
description: What the seeder creates, how to run it, and the knobs that tune it.
sidebar:
  order: 4
---

`npm run seed` (`scripts/seed.ts`) is a long-running seeder that gives a fresh
install something to show. It does three things.

## 1. Bootstrap, once

It registers four demo sources and their demo dashboards in the `demo`
workspace, if they do not already exist (the fourth only when
`PROMETHEUS_SELF_URL` is set). Three are TimescaleDB sources that point
at the `metrics` schema and share the read-only `TS_METRICS` secret reference;
they differ only in the tables they expose. The fourth is a Prometheus source:
the compose stack's own Prometheus, which scrapes the app.

| Source id | Table | Demo dashboard |
| --- | --- | --- |
| `ts-metrics` | `metrics.http_requests` — per-request events | **Demo service health** (RPS, p95 latency, 5xx, requests by route) |
| `ts-system` | `metrics.system_metrics` — per-host infra metrics | **Demo infrastructure** (CPU/memory by host, disk %, CPU by region), **Demo fleet status** (a text header, CPU and disk gauges, a host load state timeline) and **Demo host detail** (one host, picked with a `host` variable) |
| `holotable-self` | `metrics.holotable_self` — the app's own instruments | **Holotable self-monitoring**, below |
| `prometheus-self` | Prometheus at `PROMETHEUS_SELF_URL` — the same instruments, scraped | **Holotable self-monitoring (Prometheus)**, below |

The demo dashboards show [drilldown](/guide/drilldown/) too. On **Demo fleet
status**, a click on a host's CPU bar or on one of its load-state lanes opens
**Demo host detail** for that host. The CPU chart on **Demo infrastructure**
has an *Open host detail* item in its panel menu. On **Demo host detail**, a
click on a row of the host table switches the page to that host in place.
A link names its target by dashboard id, so the seeder writes **Demo host
detail** before the dashboards that link to it.

A demo dashboard the seeder wrote and nobody has saved since is brought up to
the current demo spec on the next start, as a new version noted *Updated by
the demo seeder*. That is how an install seeded before the drilldown links
gets them. Once a person saves one of these dashboards, the seeder leaves it
alone.

Each source is stamped with a `catalog_refreshed_at` as it is written. A source
that has never been introspected is refused by the [catalog freshness
check](/concepts/generating-a-panel/) before the model is called, and a catalog
seeded from this file has, in the only sense that matters, just been
introspected.

## 2. Backfill (optional)

With `SEED_BACKFILL` set to a duration such as `6h`, the seeder first writes
the history it would have produced across that window, at the same
`SEED_INTERVAL_MS` cadence and with the same row shapes as the loop. A fresh
database then opens on full charts instead of filling in over the first
minutes. It writes `metrics.http_requests` and `metrics.system_metrics` in
multi-row inserts of at most 5 000 rows, logging once per insert. Then it
refreshes the `metrics.http_requests_1m` continuous aggregate over the same
range, so the aggregate has data at once rather than after its policy's first
run. Six hours at the default cadence is about 540 000 request rows and takes
seconds.

Each table is filled from the window start or from just after its newest
existing row, whichever is later. So a restart with a mounted volume fills only
the time it was down and never doubles the history, and a restart right away
writes nothing.

`metrics.holotable_self` is never backfilled. The self-monitoring dashboard
shows Holotable's real samples from the moment it starts, which is the point
of that source.

## 3. Loop

Every `SEED_INTERVAL_MS` it inserts a fresh batch of synthetic rows into both
tables so the live dashboards stream. It connects with the privileged metrics
user and ensures the demo hypertables exist first, so it also works against a
database whose volume predates a table.

## Running it

```bash
# Docker: the `seed` service runs automatically with `docker compose up`.
# Local:
npm run seed                       # requires DATABASE_URL and TIMESCALEDB_URL
```

Bootstrap writes the source and dashboard rows to `DATABASE_URL` (the config
store); the metric inserts go to `TIMESCALEDB_URL`, which falls back to
`DATABASE_URL`. In the default single-instance setup these are the same
database.

## Knobs

| Variable | Default | Effect |
| --- | --- | --- |
| `SEED_INTERVAL_MS` | `2000` | Delay between insert batches (Docker dev override: `1000`). |
| `SEED_DEMO` | — | Set to `false` to skip the one-time bootstrap and only stream metrics. |
| `SEED_BACKFILL` | — | History to write before streaming: `30m`, `6h`, `1d`, at most `7d`. Unset writes none. An invalid value exits 1. |
| `TS_METRICS_HOST` / `TS_METRICS_PORT` | `localhost` / `5432` | Host and port written into the seeded source configs. |
| `POSTGRES_DB` | `holotable` | Database name written into the seeded source configs. |
| `PROMETHEUS_SELF_URL` | — | Where the seeded `prometheus-self` source asks: `http://prometheus:9090` in compose, `http://localhost:9090` in `.env.example`. Unset, the Prometheus source and its dashboard are not seeded, as in the quick-start image. The app reaches it only if `SOURCE_URL_ALLOWLIST` names its host. |
| `SELF_METRICS_INTERVAL_MS` | `15000` | Collector only: delay between scrapes of `/api/metrics`. |
| `METRICS_URL` | `http://app:3000/api/metrics` | Collector only: what to scrape. |
| `SMOKE_TIMEOUT_MS` | `180000` | Smoke test only: how long to wait for the first panel with rows. |

:::caution
The seeder is for demos and local development. It uses a **privileged**
connection to insert data and create tables; the application itself only ever
reads through the read-only `TS_METRICS` role. Do not run the seeder against
production data.
:::

## The metrics schema

`metrics.http_requests` is a hypertable of raw request events (see
`timescaledb/init/001_schema.sql`). A continuous aggregate pre-aggregates
per-minute request, error, duration, and byte statistics, and a seven-day
retention policy removes old raw chunks. `metrics.system_metrics` and
`metrics.holotable_self` are hypertables in the same file. A **read-only** role is created by
`timescaledb/init/002_readonly_user.sh`; the app only ever connects as this user
via the source's `secret_ref`.

## The self-monitoring demo

The first two demo sources show the mechanism on synthetic rows. The third shows
the point: Holotable watching itself.

`scripts/self-metrics.ts` scrapes the app's own `GET /api/metrics` every
`SELF_METRICS_INTERVAL_MS` and lands one row per series per scrape in the
`metrics.holotable_self` hypertable. The seeder registers that table as the
`holotable-self` source, and the **Holotable self-monitoring** dashboard reads it
back through the ordinary path — catalog allowlist, SQL guard, server-owned time
range, guarded execution, live streaming — with nothing special-cased.

```
app  ──GET /api/metrics──▶  self-metrics  ──INSERT──▶  metrics.holotable_self
                                                              │
 browser  ◀──SSE──  poller  ◀──guarded SELECT──  holotable-self source
```

For the SQL side, something has to put the samples in a table. That is all the
collector is: a loop, a text-format parser
(`src/lib/self-monitoring/exposition.ts`), and an `INSERT`.

### The Prometheus twin

The compose stack also runs Prometheus, which scrapes the same `/api/metrics`
every 15 seconds. The seeder registers it as `prometheus-self`, a
[Prometheus source](/concepts/prometheus-sources/) with `auth: none` at
`PROMETHEUS_SELF_URL` (`http://prometheus:9090` inside the stack,
`http://localhost:9090` from the host), and the app reaches it because
`SOURCE_URL_ALLOWLIST` names that host. Its allowlist is `up` and the
`holotable_*` families the panels read.

**Holotable self-monitoring (Prometheus)** has the same panels as the SQL
dashboard, written in PromQL (`src/lib/self-monitoring/prometheus.ts`). Where the
SQL panels sum a metric's series and take `max - min` per bucket, the PromQL
ones say `sum(rate(…[5m]))`, and the server picks the step. Side by side, the
two dashboards answer the same questions in each language.

```
app  ◀──scrape──  prometheus  ◀──query_range──  prometheus-self source
                                                       │
 browser  ◀──SSE──  poller  ◀──guarded PromQL───────────┘
```

### The table

| Column | Meaning |
| --- | --- |
| `ts` | When the scrape happened |
| `metric` | Metric name as exposed, including any `_bucket` / `_sum` / `_count` suffix |
| `labels` | The full label set, canonically serialized, so two series never collapse into one row |
| `dashboard`, `source`, `workspace`, `model`, `direction`, `route`, `reason`, `outcome` | The labels the app's own instruments use, promoted to columns |
| `le` | Histogram bucket bound — `NULL` for `+Inf`, so a panel can write `le IS NOT NULL` instead of the literal `'infinity'`, which the SQL guard refuses because to PostgreSQL that string is also a timestamp |
| `value` | The sample value |

Counters and histogram buckets are cumulative since the process started, so
every rate panel does the same two things in order: sum across a metric's series
at each `ts`, *then* take `max - min` inside a time bucket. Doing it the other
way round subtracts one series' counter from another's.

The collector stores an allowlist of metric families rather than everything a
scrape carries — it is a demo collector, not a general ingester. The allowlist
lives beside the dashboard spec, and `npm test` asserts that every metric a
panel queries is one the collector keeps.

### The committed specs

The dashboard specs live in `src/lib/self-monitoring/`, not inline in the
seeder, which is what lets `npm test` hold them to the contract:

- each parses against the current IR, and both are fixtures in the IR library;
- every SQL panel passes the real SQL guard against the committed catalog, and
  every PromQL panel passes the real PromQL guard with no hint;
- the PromQL catalog lists only metrics the app's registry really exports, and
  both dashboards read the same metric families;
- every panel builds an executable plan with the server's time parameters bound;
- it carries no host, port, credential, or `secret_ref` — [invariant
  5](/architecture/invariants/).

### The smoke test

```bash
docker compose --profile smoke run --rm smoke
```

`scripts/smoke.ts` waits for the seeder, the collector and Prometheus, then runs
every panel of both dashboards through the source kind's check, plan and
execute: the same functions in the same order as `POST /api/query`. It fails
unless at least one panel of each comes back with rows, which can only happen
if the collector, and Prometheus, really scraped the running app.

It asserts "at least one" because an idle stack has nobody viewing a dashboard,
so there are no pollers, no live viewers, and no model calls; resident memory is
the series that is live from boot. What it deliberately does not cover is the
HTTP and session layer above those functions: reaching
`/api/dashboards/[id]/stream` needs a signed-in browser session.
