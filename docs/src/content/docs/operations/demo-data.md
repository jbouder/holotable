---
title: Demo data
description: What the seeder creates, how to run it, and the knobs that tune it.
sidebar:
  order: 4
---

`npm run seed` (`scripts/seed.ts`) is a long-running seeder that gives a fresh
install something to show. It does three things, and a fourth when there is a
Loki to ask.

## 1. Bootstrap, once

It registers five demo sources and their demo dashboards in the `demo`
workspace, if they do not already exist (the fifth only when
`PROMETHEUS_SELF_URL` is set). Under `AUTH_MODE=local` they go to the local
owner's workspace instead, the first `LOCAL_GROUPS` names (`local` by
default), so the [quick start](/getting-started/quick-start/) opens on them
([local mode](/admin/demo-mode/#local-mode)); the smoke test reads the same
workspace. Four are TimescaleDB sources that point
at the `metrics` schema and share the read-only `TS_METRICS` secret reference;
they differ only in the tables they expose. The fifth is a Prometheus source:
the compose stack's own Prometheus, which scrapes the app. A sixth, the
`logs` profile's Loki, is registered by the loop once it answers (below).

| Source id | Table | Demo dashboard |
| --- | --- | --- |
| `ts-metrics` | `metrics.http_requests` — per-request events; `metrics.service_calls` — calls between services, a minute a row | **Demo service health** |
| `ts-system` | `metrics.system_metrics` — per-host infra metrics | **Demo fleet** and **Demo host detail** |
| `ts-logs` | `metrics.app_logs` — gateway log lines | The logs on **Demo service health** and **Demo host detail** |
| `holotable-self` | `metrics.holotable_self` — the app's own instruments | **Holotable self-monitoring**, below |
| `prometheus-self` | Prometheus at `PROMETHEUS_SELF_URL` — the same instruments, scraped | **Holotable self-monitoring (Prometheus)**, below |
| `loki-self` | Loki at `LOKI_SELF_URL` — the stack's container log lines, the app's among them | **Holotable logs**, below |

Three demo dashboards each answer one question, and between them use every
panel kind:

- **Demo service health**: is the API serving well? The 5xx error rate, p95
  latency and the share of requests over the 300 ms SLO as stats with
  sparklines, availability as a gauge, requests per minute by outcome, the
  request flow from service to route to status (a
  [Sankey](/reference/panel-options/#sankey)), a service map of which service
  calls which (a [graph](/reference/panel-options/#graph), drawn as a
  directed graph), the latency band
  against the SLO
  (a [custom visual](/architecture/custom-visuals/)) beside the latency
  histogram, the slowest routes, server errors by route, requests by service,
  and the gateway's recent errors and warnings.
- **Demo fleet**: which hosts need attention, and why? Status grids of CPU and
  disk now, CPU by host over time, memory as gauge bars, a CPU heatmap by host
  and minute, the load-state timeline, network in as a region-then-host
  treemap, CPU against memory as a scatter, every five-minute CPU reading as a
  tick plot (a custom visual), and a table of hosts.
- **Demo host detail**: one host, picked with a `host` variable: its CPU,
  memory, disk and network, its own log lines and their levels, and the other
  hosts.

They show [drilldown](/guide/drilldown/) too. **Demo service health** has a
`service` variable, the API's three services, all of them picked by default
(a variable has no "all" value, so a multi-select defaulting to every value
is how the dashboard shows everything until it is narrowed), and every panel
over `http_requests` filters by it. A click on a service on the service map
shows that service; a click on a store shows the service that calls it; the
gateway, which is no one service, and the `redis` two services share offer
nothing. A click on a service in the request flow, or on a band leaving one,
shows that service too; a route or a status offers nothing. On **Demo fleet**, a click on a
host anywhere (a tile, a line, a bar, a lane or a row of the hosts table)
opens **Demo host detail** for that host, and the heatmap has an *Open host
detail* item in its panel menu. On **Demo files**, where the seeder writes it,
a click on a host in the network topology opens **Demo host detail** for that
host; a router or a switch offers nothing. On **Demo host detail**, a click on a row of
the host table switches the page to that host in place. A link names its
target by dashboard id, so the seeder writes **Demo host detail** before the
dashboard that links to it.

A demo dashboard the seeder wrote and nobody has saved since is brought up to
the current demo spec on the next start, as a new version noted *Updated by
the demo seeder*. That is how an install seeded before the drilldown links
gets them. Once a person saves one of these dashboards, the seeder leaves it
alone.

Earlier seeds wrote more demo dashboards (*Demo infrastructure*, *Demo fleet
status*, *Demo fleet grid*, *Demo gateway logs* and *Demo custom visuals*),
now folded into the three above. The seeder deletes each of them it still
owns on its next start; one a person has saved stays.

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
minutes. It writes `metrics.http_requests`, `metrics.system_metrics`,
`metrics.app_logs` and `metrics.service_calls` (a minute a row, whatever the
cadence) in multi-row inserts of at most 5 000 rows, logging once per insert. Then it
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

Every `SEED_INTERVAL_MS` it inserts a fresh batch of synthetic rows into the
demo tables so the live dashboards stream, and once a minute a row per edge
of the service map. It connects with the privileged metrics
user and ensures the demo hypertables exist first, so it also works against a
database whose volume predates a table.

With `LOKI_SELF_URL` set, the loop also asks that Loki's `/ready` every ten
seconds until it answers, then registers the `loki-self` source and the
**Holotable logs** dashboard, once. A stack without the `logs` profile has no
Loki, so it never gets either, and a profile brought up later gets both within
seconds. See [The logs profile](#the-logs-profile).

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
| `PROMETHEUS_SELF_URL` | — | Where the seeded `prometheus-self` source asks: `http://prometheus:9090` in compose, `http://localhost:9090` in `.env.example`. Unset, the Prometheus source and its dashboard are not seeded, as in the quick-start image. The app reaches it only if `SOURCE_URL_ALLOWLIST` names its host. Smoke test too: set, it checks the PromQL self-monitoring dashboard; unset, it skips it. |
| `LOKI_SELF_URL` | — | Where the seeded `loki-self` source asks, once it answers: `http://loki:3100` in compose, `http://localhost:3100` in `.env.example`. Unset, the Loki source and the Holotable logs dashboard are not seeded, as in the quick-start image. Smoke test too: set, it checks the Holotable logs dashboard; empty, it skips it. |
| `SELF_METRICS_INTERVAL_MS` | `15000` | Collector only: delay between scrapes of `/api/metrics`. |
| `METRICS_URL` | `http://app:3000/api/metrics` | Collector only: what to scrape. |
| `SMOKE_TIMEOUT_MS` | `180000` | Smoke test only: how long to wait for the first panel with rows. |
| `SMOKE_APP_URL` | — | Smoke test only: where the app answers (`http://app:3000` in compose). Set, one **Demo files** panel also runs through the app's own `POST /api/query`. |

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
retention policy removes old raw chunks. `metrics.system_metrics`,
`metrics.app_logs`, `metrics.service_calls` and `metrics.holotable_self` are
hypertables in the same file.

`metrics.service_calls` (`ts`, `caller`, `callee`, `tier`, `requests`,
`errors`, `p95_ms`) is the service map's: one row per caller and callee a
minute. `gateway` calls the API's three services, `api`, `web` and `worker`
(tier `service`, the same names as `http_requests.service`), each calls its
own store, `api-db` (tier `database`), `web-cache` (`cache`) and
`worker-queue` (`queue`), and `api` and `web` share a `redis` (tier `store`,
[#624](https://github.com/jbouder/holotable/issues/624)). With a node of two
parents the map is not a tree, so the panel draws it with `layout: "dag"`,
the layered directed graph; its SQL gives the shared store no `service`, so
its click is no dead link. The seeder deletes rows an earlier topology wrote
for edges the map no longer has. The gateway's requests follow `http_requests`' rhythm at the default cadence, and
about 3% of calls fail, as its 5xx do. A **read-only** role is created by
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

### The logs profile

The SQL and PromQL dashboards read what the app counts. The third reads what
it says. `docker compose --profile logs up` adds two services:

- **Loki** (`grafana/loki`, single binary, no volume), published on `3100`.
- **Grafana Alloy** (`grafana/alloy`), which lists this compose project's
  containers through the Docker socket, read-only, and pushes their log lines
  to Loki labeled `app` (the compose service), `env` (`dev`) and `container`.

The seeder registers that Loki as `loki-self`, a [Loki
source](/concepts/loki-sources/) with `auth: none` at `LOKI_SELF_URL`, its
allowlist `app`, `container` and `env` with the values the live Loki has. The
app reaches it because `SOURCE_URL_ALLOWLIST` names `loki`.

The app's log lines are one JSON object each (`src/lib/log.ts`), so
**Holotable logs** (`src/lib/self-monitoring/loki.ts`) reads `{app="app"}`,
parses with `| json` and filters on the fields the server writes:

- log lines by level per minute, and errors and warnings by route;
- the p95 of `durationMs` per route, from `request.completed` lines, with
  `unwrap`;
- guard refusals by language and reason, from the `guard.refused` line every
  refusal writes beside its counter;
- a request log (method, route, status and duration, through `line_format`)
  and the error lines, as `logs` panels.

```
app  ──stdout──▶  alloy  ──push──▶  loki  ◀──query_range──  loki-self source
                                                                  │
 browser  ◀──SSE──  poller  ◀──guarded LogQL───────────────────────┘
```

An idle stack has lines from boot (the configuration report) and few after:
`/api/health` and `/api/metrics` log at `debug`. Open a dashboard, or ask for
something that fails, and the request panels fill. The [quick-start
image](/getting-started/quick-start/) stays TimescaleDB-only and has none of
this, as it has no Prometheus.

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

- each parses against the current IR, and all three are fixtures in the IR
  library;
- every SQL panel passes the real SQL guard against the committed catalog,
  every PromQL panel passes the real PromQL guard with no hint, and every LogQL
  panel passes the real LogQL guard against the committed labels with no hint
  and filters only on messages the app logs;
- the PromQL catalog lists only metrics the app's registry really exports, and
  both dashboards read the same metric families;
- every panel builds an executable plan with the server's time parameters bound;
- it carries no host, port, credential, or `secret_ref` — [invariant
  5](/architecture/invariants/).

### The smoke test

```bash
docker compose --profile smoke run --rm smoke
```

`scripts/smoke.ts` waits for the seeder, the collector, Prometheus and Loki,
then runs every panel of the three self-monitoring dashboards and **Demo
service health** through the source kind's check, plan and execute: the same
functions in the same order as `POST /api/query`. It fails unless at least one
panel of each comes back with rows, which can only happen if the collector and
Prometheus really scraped the running app, and Alloy really shipped its lines
to Loki. The Holotable logs dashboard is checked while `LOKI_SELF_URL` is set,
which compose does by default, so bring the stack up with `--profile logs`
first (`LOKI_SELF_URL= docker compose --profile smoke run --rm smoke` smokes a
stack without it).

It asserts "at least one" because an idle stack has nobody viewing a dashboard,
so there are no pollers, no live viewers, and no model calls; resident memory is
the series that is live from boot. What it deliberately does not cover is the
session layer: reaching `/api/dashboards/[id]/stream` needs a signed-in
browser session.

Those functions run in the smoke container, which has every dependency
installed; the app's image has only what `next build` traced. So, with
`SMOKE_APP_URL` set (compose sets it), the smoke test also sends one
**Demo files** panel to the app's own `POST /api/query` and fails unless it
answers with rows. It signs that request with a
[service-account token](/integrations/api-tokens/) it creates in the database for the
purpose, an editor of the seeded workspace for ten minutes, and revokes it
once the answer is in. DuckDB is the kind that needs this: its binding is
native, and a runtime image missing part of it answers every DuckDB source
"DuckDB is not available on this server" (#615).

## The files demo

With `DUCKDB_SOURCES_DIR` set, the seeder also shows a
[DuckDB source](/concepts/duckdb-sources/): data that lives in files rather
than in a database. Docker Compose and the quick-start image set it
([#600](https://github.com/jbouder/holotable/issues/600)). Before anything
else, the seeder writes five files under `<DUCKDB_SOURCES_DIR>/demo/` with the binding itself
(`scripts/lib/demo-files.ts`), so nothing binary is ever committed:

| File | Table | What it holds |
| --- | --- | --- |
| `http_requests.parquet` | `http_requests` | Per-request events for the last seven days: `ts`, `service`, `route`, `host`, `status`, `duration_ms`, `bytes`. The demo's request shape, three to six requests a minute, busier in the afternoon (UTC). |
| `hosts.csv` | `hosts` | The host inventory: `host`, `region`, `role`, `cores`. |
| `links.csv` | `links` | The network under the hosts ([#624](https://github.com/jbouder/holotable/issues/624)), one row per link from the device above to the one below: `parent`, `child`, `tier` (the child's: `router`, `switch` or `server`) and `bandwidth_gbps`. Two core routers linked to each other, each to both distribution switches, those to three access switches, and those to the hosts of `hosts.csv` by name, two of them dual-homed. Several parents and a cycle, so not a tree. |
| `daily_revenue.parquet` | `daily_revenue` | Orders and revenue per region per day for the last 90 days, ending yesterday: `day`, `region`, `orders`, `revenue`. |
| `deploys.jsonl` | `deploys` | One JSON object per deploy for the last seven days ([#596](https://github.com/jbouder/holotable/issues/596)): `ts`, `service`, `version`, `ok`, and a nested `actor` object, read as `actor STRUCT("name" VARCHAR, team VARCHAR)`. |

It registers them as the **Demo files** source (`duckdb-demo`, path `demo`,
no `secret_ref`) with that catalog, and seeds the **Demo files** dashboard.
Requests per minute and the 5xx rate come from `time_bucket` panels over the
Parquet file. Daily revenue by region comes from a `date_trunc` panel with
its own 30-day window. Requests by region joins the Parquet file to the CSV,
a table of revenue by region covers the whole file, a table of deploys
reads the JSON-lines file, its nested object as `actor.name` and
`actor.team`, and a network topology draws `links.csv` joined to the host
inventory as a top-to-bottom directed graph, routers, switches and servers as
icons, each link as wide as its bandwidth, the core routers' loop dashed.

Every value in the files is a function of its minute or day, so the seeder
can rewrite them every minute, and does. Each file is written beside its
final name as a hidden `.tmp` and renamed over it, which moves the live edge
forward without the history changing under a dashboard. The app's engine reads
the new file on its next query, with no refresh needed.

In Compose, the files are a named volume, `duckdb-files`, mounted at
`/data/duckdb`. The seeder mounts it read-write and writes `demo/`. The app
mounts it read-write too, because it writes `uploads/`, the CSV and JSON files source
admins [upload from the browser](/admin/duckdb/#uploads); the smoke test
mounts it **read-only**. For
the host loop (`npm run seed` with `npm run dev`), point
`DUCKDB_SOURCES_DIR` at an absolute path, such as this checkout's
`data/duckdb`, which is gitignored, and give the app the same value.

The [smoke test](#the-smoke-test) runs **Demo files** too, through the DuckDB
kind's check, plan and execute, and fails unless one of its panels comes back
with rows, both in its own process and through the app. `npm test` holds the spec to the IR and the SQL guard against the
seeded catalog, and the end-to-end suite opens the dashboard and waits for its
panels to go live.
