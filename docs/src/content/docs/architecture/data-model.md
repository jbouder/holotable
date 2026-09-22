---
title: Data model
description: The config store, the append-only version table, and the metrics schema.
sidebar:
  order: 4
---

Holotable uses two logical databases. In the default single-instance setup they
are the same TimescaleDB instance.

## Config store (PostgreSQL)

Metrics **data** never lives here — only configuration and validated specs.

### `sources`

The registry: safe `config` (jsonb), `secret_ref`, `workspace_id`,
`tombstoned_at`. Credentials are never stored; `secret_ref` names an environment
variable family from which they are resolved at execution time.

Referenced sources are **tombstoned** rather than deleted, so dashboards
referencing them keep resolving to a tombstone marker instead of breaking
silently.

### `dashboards`

Identity: `workspace_id`, `title`, `created_by`, `current_version_id`,
`deleted_at`. Deletion is a soft delete.

### `dashboard_versions`

**Append-only**: `dashboard_id`, `version`, and the entire validated spec as
`jsonb`. A new row is written on every save; existing rows are never mutated.

This is the property that makes viewing and polling pure replays of a fixed
spec, and it means a saved dashboard is a stable, auditable artifact. The full
history already exists in the database — surfacing it is
[#73](https://github.com/jbouder/holotable/issues/73).

:::caution
Stored specs are parsed against the **current** schema, and every IR object is
`.strict()`. Until the IR carries a version field and an upgrader chain
([#58](https://github.com/jbouder/holotable/issues/58)), the first breaking IR
change would invalidate every saved dashboard on read.
:::

### `llm_usage`

Token counters per `(workspace_id, day, route, model)`: `input_tokens`,
`output_tokens`, `requests`. Each finished model call adds to its row. Never
prompts, specs, or output. Read before every model request to enforce the
daily budget; see [LLM rate limits and budgets](/operations/llm-limits/).

### `workspace_limits`

Optional per-workspace overrides of `LLM_RATE_PER_MINUTE` and
`LLM_DAILY_TOKEN_BUDGET`: `rate_per_minute`, `daily_token_budget`. A `NULL`
column inherits the environment; `0` disables that limit.

## Metrics store (TimescaleDB)

- `metrics.http_requests` is a hypertable containing raw request events (see
  `timescaledb/init/001_schema.sql`).
- A continuous aggregate pre-aggregates per-minute request, error, duration, and
  byte statistics; a seven-day retention policy removes old raw chunks.
- A **read-only** role is created by `timescaledb/init/002_readonly_user.sh`.
  The app only ever connects as this user, via the source's `secret_ref`.

## Migrations

`scripts/migrate.ts` applies `migrations/*.sql` in filename order inside a
transaction, recording each in `schema_migrations` so it runs once. Every
migration declares a rollback or an explicit reason it has none, concurrent
runs serialize on an advisory lock, and `--check` is the pipeline gate against
deploying code ahead of its schema. See
[Database migrations](/operations/migrations/).
