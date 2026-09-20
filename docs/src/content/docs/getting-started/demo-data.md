---
title: Demo data
description: What the seeder creates, how to run it, and the knobs that tune it.
sidebar:
  order: 3
---

`npm run seed` (`scripts/seed.ts`) is a long-running seeder that gives a fresh
install something to show. It does two things.

## 1. Bootstrap, once

It registers two demo sources and a dashboard for each in the `demo` workspace,
if they do not already exist. Both sources point at the `metrics` schema and
share the read-only `TS_METRICS` secret reference — they differ only in the
tables they expose.

| Source id | Table | Demo dashboard |
| --- | --- | --- |
| `ts-metrics` | `metrics.http_requests` — per-request events | **Demo service health** (RPS, p95 latency, 5xx, requests by route) |
| `ts-system` | `metrics.system_metrics` — per-host infra metrics | **Demo infrastructure** (CPU/memory by host, disk %, CPU by region) |

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
