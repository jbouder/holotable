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

`catalog_refreshed_at` and `catalog_missing_tables` sit beside `config` rather
than inside it: `config` is the allowlist its author owns and the browser is
shown, while these two are what the last introspection found. They are what
[catalog health](/concepts/generating-a-panel/) is computed from, and only
`POST /api/sources/[id]/refresh` writes them.

### `dashboards`

Identity: `workspace_id`, `title`, `created_by`, `current_version_id`,
`deleted_at`. Deletion is a soft delete.

Plus workspace **metadata**: `description` and `tags text[]`. These are *about*
the dashboard rather than part of it — nothing executes them, they are not in
the spec IR, and they do not travel in an export — which is why editing them
writes the row in place instead of appending a version, and why they cost no
`specVersion` bump.

:::note[The spec owns the title]
`dashboards.title` is a **mirror**: `saveDashboardVersion` writes it from
`spec.title` on every save. A rename therefore cannot be a column update — the
next save would silently undo it — so `PATCH /api/dashboards/[id]` with a
`title` appends a version whose spec differs only in its name. The alternative
(the row wins, and the copy stops) was rejected because the spec is what an
export carries, what the chat prompt names, and what the viewer's header reads;
two answers to "what is this dashboard called" is worse than one extra version
row. The decision is recorded as `TITLE_AUTHORITY` in
`src/lib/dashboard-metadata.ts`.
:::

### `dashboard_favorites`

`user_sub`, `dashboard_id`, `created_at`. Favouriting is **per person**, so it
keys on the identity's subject and sits outside the dashboard row everyone
shares; the API takes the subject from the validated session and never from a
request field. `ON DELETE CASCADE`, because a favourite of a deleted dashboard
is a bookmark to nothing rather than a dangling reference.

### `dashboard_versions`

**Append-only**: `dashboard_id`, `version`, the entire validated spec as
`jsonb`, and an optional `note` — the author's own one line about what changed,
written in the editor and displayed as-is. A new row is written on every save;
existing rows are never mutated.

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

### `templates`

A reusable spec: `workspace_id`, `kind` (`panel` or `dashboard`), `name`,
`description`, and `body` as `jsonb`. The body **is** the IR — a `Panel` or a
`Dashboard` tagged with which one — so it is validated against the same schema
on write and on read, and it carries no connection detail or credential for the
same reason a dashboard version does not.

Two constraints hold the row together: `kind = body->>'kind'`, so the column
can be filtered on without becoming a second opinion about the contents, and
`UNIQUE (workspace_id, kind, name)`, because two rows that read identically in
a picker are a bug rather than a feature (the API answers that clash with a
`409`).

Deleting a template is a hard delete. Instantiating one copies its spec into an
ordinary dashboard, so unlike a source there is never a reference left pointing
back at the row.

### `chat_messages`

One dashboard-chat message: the SDK's own `id`, `dashboard_id`, `user_sub`,
`role`, and the whole message as `jsonb` in `content`. The primary key is
`(dashboard_id, user_sub, id)` — the id is unique per *conversation*, and the
conversation is that pair, which is also the only way rows are ever read. A
re-sent turn therefore updates the row it belongs to instead of appending a
duplicate.

Per person, not per dashboard: a chat is a reader working something out, not a
shared annotation (annotations are
[#68](https://github.com/jbouder/holotable/issues/68)). `ON DELETE CASCADE` for
the same reason as a favourite.

`content` is deliberately opaque rather than a column per part kind — the
message shape is the AI SDK's, it evolves, and a second opinion about it would
drift. Nothing executes a row: the model's SQL reaches the database only
through the guarded `runQuery` tool, which re-validates whatever it is handed,
so replaying a stored turn cannot run anything. It is read back as untrusted
all the same, and a row that no longer parses is dropped.

Bounded by `CHAT_HISTORY_MAX_MESSAGES` and `CHAT_HISTORY_RETENTION_DAYS`, swept
in the same transaction as each write — the only way a row is added is the only
way rows are removed, so there is no scheduled job to forget to run.

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
