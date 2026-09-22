---
title: Demo data
description: What the seeder creates, how to run it, and the knobs that tune it.
sidebar:
  order: 4
---

`npm run seed` (`scripts/seed.ts`) is a long-running seeder that gives a fresh
install something to show. It does two things.

## 1. Bootstrap, once

It registers three demo sources and a dashboard for each in the `demo`
workspace, if they do not already exist. All three point at the `metrics` schema
and share the read-only `TS_METRICS` secret reference — they differ only in the
tables they expose.

| Source id | Table | Demo dashboard |
| --- | --- | --- |
| `ts-metrics` | `metrics.http_requests` — per-request events | **Demo service health** (RPS, p95 latency, 5xx, requests by route) |
| `ts-system` | `metrics.system_metrics` — per-host infra metrics | **Demo infrastructure** (CPU/memory by host, disk %, CPU by region) |
| `holotable-self` | `metrics.holotable_self` — the app's own instruments | **Holotable self-monitoring**, below |

Each source is stamped with a `catalog_refreshed_at` as it is written. A source
that has never been introspected is refused by the [catalog freshness
check](/concepts/generating-a-panel/) before the model is called, and a catalog
seeded from this file has, in the only sense that matters, just been
introspected.

## 2. Loop

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
| `TS_METRICS_HOST` / `TS_METRICS_PORT` | `localhost` / `5432` | Host and port written into the seeded source configs. |
| `POSTGRES_DB` | `holotable` | Database name written into the seeded source configs. |
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
retention policy removes old raw chunks. A **read-only** role is created by
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

Holotable reads SQL, not PromQL, so something has to put the samples in a table.
That is all the collector is: a loop, a text-format parser
(`src/lib/self-monitoring/exposition.ts`), and an `INSERT`. Prometheus is still
in `docker-compose.yml` under the `metrics` profile for anyone who wants the
real scraper and its alerting; the demo does not go through it.

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

### The committed spec

The dashboard spec lives in `src/lib/self-monitoring/dashboard.ts`, not inline in
the seeder, which is what lets `npm test` hold it to the contract:

- it parses against the current IR, so it doubles as an IR snapshot;
- every panel's SQL passes the real SQL guard against the committed catalog;
- every panel builds an executable plan with the server's time parameters bound;
- it carries no host, port, credential, or `secret_ref` — [invariant
  5](/architecture/invariants/).

### The smoke test

```bash
docker compose --profile smoke run --rm smoke
```

`scripts/smoke.ts` waits for the seeder and the collector, then runs every panel
through `validateSql` → `resolveTimeRange` → `buildExecutablePlan` →
`executePlan`: the same functions in the same order as `POST /api/query`. It
fails unless at least one panel comes back with rows, which can only happen if
the collector really scraped the running app.

It asserts "at least one" because an idle stack has nobody viewing a dashboard,
so there are no pollers, no live viewers, and no model calls; resident memory is
the series that is live from boot. What it deliberately does not cover is the
HTTP and session layer above those functions — reaching `/api/stream` in a
browser needs a Keycloak login, which is not something CI should hold.
