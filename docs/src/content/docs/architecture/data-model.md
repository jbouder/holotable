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

The registry: `kind`, safe `config` (jsonb), `secret_ref`, `workspace_id`,
`tombstoned_at`. Credentials are never stored; `secret_ref` names an environment
variable family from which they are resolved at execution time.

`kind` says which shape `config` holds and which language the source's queries
are written in, and a row whose `config.kind` disagrees with it is refused
when it is read:

| `kind` | `config` | Queries |
| --- | --- | --- |
| `timescaledb` | `host`, `port`, `database`, `schema`, `ssl`, `tables` (each with its `columns` and `timeField`), optional `rowFilter` `{ column, claim }` | SQL |
| `prometheus` | `url`, `auth` (`none`, `bearer` or `basic`), `metrics` (each with its `type`, `help` and `labels`), optional `rowFilter` `{ label, claim }` | PromQL |

#### Source kinds

A kind is a registered module, not a `switch` on the column (#382).
`src/lib/sources/registry.ts` lists the kinds; each declares its stored `kind` (never renamed), its strict
`config` schema, the `connection`, `catalog` and `listing` projections of a
source, and the `language` a panel against it carries. Its server half, under
`src/lib/sources/server/`, holds what the browser never reaches — discovery,
refresh, the connection test, validation, planning and execution — and a kind
without one is a compile error. Registering a kind is an import, never a lookup
by a string a request supplied, and `test/source-kinds.test.ts` fails on a kind
comparison or a `src/lib/timescaledb/` import outside `src/lib/sources/`.

The discriminator was defaulted rather than migrated: the TimescaleDB branch
reads a missing `config.kind` as `timescaledb`, so every config stored before
the union parses unchanged, and the next save writes `kind` into both the
column and the JSONB from the one value. No other kind may default its
discriminator. The language belongs to the kind, not the panel: a line chart
can be drawn from SQL or from PromQL, and what decides is what its source can
answer. A source's kind cannot change on edit.

`secret_ref` is nullable (migration 018) for a Prometheus source with
`auth: none`, which needs no credential; a TimescaleDB source and an
authenticated Prometheus source always name one.

Referenced sources are **tombstoned** rather than deleted, so dashboards
referencing them keep resolving to a tombstone marker instead of breaking
silently.

`catalog_refreshed_at` and `catalog_missing_tables` sit beside `config` rather
than inside it: `config` is the allowlist its author owns and the browser is
shown, while these two are what the last introspection found. They are what
[catalog health](/concepts/generating-a-panel/) is computed from, and only
the apply step of `POST /api/sources/[id]/refresh` writes them. A refresh is
previewed as a diff first, and applied only if a second introspection still
matches the digest the preview handed out.

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

`user_sub`, `dashboard_id`, `created_at`. Favoriting is **per person**, so it
keys on the identity's subject and sits outside the dashboard row everyone
shares; the API takes the subject from the validated session and never from a
request field. `ON DELETE CASCADE`, because a favorite of a deleted dashboard
is a bookmark to nothing rather than a dangling reference.

### `dashboard_versions`

**Append-only**: `dashboard_id`, `version`, the entire validated spec as
`jsonb`, and an optional `note` — the author's own one line about what changed,
written in the editor and displayed as-is. A new row is written on every save;
existing rows are never mutated.

This is the property that makes viewing and polling pure replays of a fixed
spec, and it means a saved dashboard is a stable, auditable artifact. The
history is readable at `/dashboards/[id]/versions`, and **restore** follows the
same rule: it appends a new row copying the old spec (noted `restored from vN`)
rather than moving `current_version_id` back.

:::note[Stored specs are versioned]
Each spec carries `specVersion`, and every IR object is `.strict()`. A row is
read through the upgrader chain in `src/lib/ir/upgrade.ts`, which brings it up
to the current version in memory before it is validated. The row itself is
never rewritten, so a breaking IR change does not strand saved dashboards. A
row with no `specVersion` predates the field and is version 1. See
[invariant 3](/architecture/invariants/#3-specs-are-immutable-and-versioned).
:::

### `templates`

A reusable spec: `workspace_id`, `kind` (`panel` or `dashboard`), `name`,
`description`, and `body` as `jsonb`. The body **is** the IR — a `Panel` or a
`Dashboard` tagged with which one — so it is validated against the same schema
on write and on read, and it carries no connection detail or credential for the
same reason a dashboard version does not. A stored body is upgraded the same
way a version row is. A dashboard records its own `specVersion`, and a panel
body records it beside the panel.

Two constraints hold the row together: `kind = body->>'kind'`, so the column
can be filtered on without becoming a second opinion about the contents, and
`UNIQUE (workspace_id, kind, name)`, because two rows that read identically in
a picker are a bug rather than a feature (the API answers that clash with a
`409`).

Deleting a template is a hard delete. Instantiating one copies its spec into an
ordinary dashboard, so unlike a source there is never a reference left pointing
back at the row.

### `chat_messages` (dropped)

The dashboard chat's history before #416. Migration 020 copied every row into
`conversations` and `conversation_messages`; migration 021 dropped the table.
Its rollback recreates it from the conversations that continue a dashboard's
chat.

### `conversations`

One person's Explore conversation (#416, the Chat engine): `id`, `user_sub`, `workspace_id`,
`source_ids`, `dashboard_id` (set when it continues a dashboard's chat; `ON
DELETE SET NULL`), `title`, `time_range` (an IR `TimeRange`), `variables` and
the two timestamps. Personal like `user_preferences`: every statement filters
on `user_sub` from the session, and no route reads another person's.

A conversation with a `dashboard_id` continues that dashboard's chat: at most one per person per dashboard (a partial unique index), with no `source_ids` of its own; its sources are the dashboard's, re-resolved from the current spec on every turn.

Nothing in a row is authorization. `source_ids` are re-resolved and
re-authorized on every turn and every panel run; `workspace_id` is derived from
the source records when the conversation is made, never from a request.

Bounded per person by `CHAT_CONVERSATIONS_MAX` (the least recently used go
first) and by `CHAT_HISTORY_RETENTION_DAYS` (one with nothing newer is gone),
swept when a conversation is created and applied on read.

### `conversation_messages`

One message of a conversation, as `chat_messages` holds one: the SDK's own
`id`, `role` and the whole message in `content`, keyed on `(conversation_id,
id)` and cascading with the conversation. A drawn panel's result rows are
**never** stored: `persistableMessage` reduces each `showPanel` output to the
panel id, columns, row count and five sample rows, and the page runs the panel
again from its stored spec. Read back as untrusted; a panel whose spec no
longer parses comes back as an error part. Bounded per conversation by
`CHAT_HISTORY_MAX_MESSAGES` and `CHAT_HISTORY_RETENTION_DAYS`, swept with each
write.

### `generation_log`

One row per model generation, or per panel an Explore turn draws (`mode = 'chat'`): `mode`, `source_id`, `prompt_redacted`,
`catalog_hash`, `spec`, `model`, `attempts`, `input_tokens`, `output_tokens`,
`error`. It answers the question a wrong dashboard raises — what was asked, and
what came back — and it is the corpus the eval harness
([#24](https://github.com/jbouder/holotable/issues/24)) will read.

Three things keep it safe to hold. The prompt is stored **redacted**
(`redactPrompt` in `src/lib/ai/log.ts`), because people paste connection
strings into free text. The catalog is stored as a **hash**, not as text: "was
this the same catalog?" is the question the column answers, and the schema
itself is not needed to answer it. `spec` is a validated IR spec, which by
construction carries opaque source ids and no connection detail.

Written on the stream's finish callback and never on a read path; a write that
fails is logged and dropped rather than failing the generation. Read only by a
workspace source-admin (or a platform admin) through `GET /api/generation-log`
— never on a dashboard, source or spec payload. Swept on write by
`GENERATION_LOG_RETENTION_DAYS`, and the same window is applied on read, so
shortening it takes effect at once.

There is deliberately no foreign key to `sources`: a log entry outliving the
source it names is the normal case, and a cascade would erase exactly the
history someone came looking for.

### `audit_log`

One row per event ([#30](https://github.com/jbouder/holotable/issues/30)):
`at`, `workspace_id`, `actor_sub`, `actor_kind`, `action`, `resource_type`,
`resource_id`, `outcome`, `request_id`, `detail`. Who signed in and out, what
was created, changed, deleted or run, and every refusal; the list is
`AUDIT_ACTIONS` in `src/lib/audit.ts` and the
[audit log](/operations/audit-log/) page.

It is **append-only**: triggers refuse `UPDATE`, `DELETE` and `TRUNCATE` for
every role, the owner included, because the app and the migrations share one
role and a grant cannot bind a table's owner. `detail` goes through the log's
redaction pass on the way in, with SQL and prompts reduced to a digest and
any result-shaped key dropped. Written fire-and-forget by `audit()`, so a failed
write is logged and counted rather than failing the request. Read only through
`GET /api/audit`. Nothing removes rows; pruning is a documented maintenance
step. Like `generation_log`, it has no foreign keys: a row outliving the
dashboard or source it names is the point.

### `llm_usage`

Token counters per `(workspace_id, day, route, model)`: `input_tokens`,
`output_tokens`, `requests`. Each finished model call adds to its row. Never
prompts, specs, or output. Read before every model request to enforce the
daily budget; see [LLM rate limits and budgets](/admin/llm-limits/).

### `workspace_limits`

Optional per-workspace overrides of `LLM_RATE_PER_MINUTE` and
`LLM_DAILY_TOKEN_BUDGET`: `rate_per_minute`, `daily_token_budget`. A `NULL`
column inherits the environment; `0` disables that limit. Platform admins edit
it from **Settings → Workspaces** through `PATCH /api/workspaces/[id]/limits`.

### `workspace_prompts`

One row per workspace that has a prompt customization (#66): `glossary`
(text), `metric_definitions` and `examples` (JSONB arrays), `updated_by`,
`updated_at`. Each example is `{ prompt, specVersion, panel }`, a lone panel
recording its IR version as a panel template does, so it is upgraded on read.
A row is read through the `WorkspacePrompt` schema; one that no longer parses
is logged and treated as no customization. Written only by
`PUT /api/workspaces/[id]/prompt`. See
[Workspace context](/concepts/generating-a-panel/#workspace-context).

### `user_preferences`

One row per subject: `sub` (primary key), `prefs` (JSONB), `updated_at`. It
holds the choices that follow a person between devices: time zone, clock,
start page and dashboard list defaults. Keyed by `sub` alone, because a
preference is personal and not workspace-scoped. Read through
`parsePreferences` in `src/lib/preferences.ts`, which validates field by field
and drops or defaults anything stale, so an old row never breaks a page. Only
`GET` and `PATCH /api/me/preferences` touch it, and only for the caller's own
`sub`. Theme and motion are deliberately not here; see
[Settings and your account](/guide/settings/).

### `sessions`

One row per renewable session (#27): `id_hash` (SHA-256 of the opaque id in
the `/api/auth` cookie, never the id itself), `sub`, `oidc_sid` (the realm's
session id, which back-channel logout deletes by, #28), `refresh_token` (AES-256-GCM
ciphertext under a key derived from `SESSION_SECRET`), `created_at`,
`refreshed_at` and `expires_at`. Written at sign-in, rewritten at each renewal
under a row lock (so concurrent renewals take turns with a rotating refresh
token), and deleted at sign-out, on a refused renewal, or once expired.
Nothing on the request path reads it. Rotating `SESSION_SECRET` makes every
stored token unreadable, which ends every session.

### `annotations`

One workspace event drawn on time-series panels (#68): `workspace_id`, `at`,
an optional `ended_at` (a range, such as an incident), `kind` (`deploy`,
`incident` or `note`), `title`, `description`, `tags`, `created_by`,
`created_at`, and `source` (`manual`, or the name of the pipeline that posted
it). Every statement filters on `workspace_id`: a read takes it from the
dashboard record, a write from the path. See
[Annotations](/guide/annotations/).

### `dashboard_shares`

One read-only share link (#65): `dashboard_id`, `workspace_id`, `token_hash`
(SHA-256 of the `hts_` token, never the token), `label`, `allowed_origins`,
an optional pinned `time_range`, `created_by`, `created_at`, `expires_at`,
`revoked_at` and `last_used_at`. Checked on every use of the token, so
revoking takes effect on the next request. See
[Share links and embedding](/integrations/share-links/).

### `api_tokens`

One service-account API token (#288): `workspace_id`, `name`, `token_hash`
(SHA-256 of the `ht_` token), `role` (`viewer` or `editor` only, by a `CHECK`),
`created_by`, `created_at`, `expires_at`, `revoked_at` and `last_used_at`. See
[Service-account API tokens](/integrations/api-tokens/).

## Metrics store (TimescaleDB)

`timescaledb/init/001_schema.sql` creates the demo schema:

- `metrics.http_requests` is a hypertable of raw request events. A continuous
  aggregate, `metrics.http_requests_1m`, pre-aggregates per-minute request,
  error, duration and byte statistics; a seven-day retention policy removes old
  raw chunks.
- `metrics.system_metrics` holds per-host infrastructure samples, and
  `metrics.holotable_self` the app's own Prometheus instruments, scraped by
  `scripts/self-metrics.ts`. See [Demo data](/operations/demo-data/).
- A **read-only** role is created by `timescaledb/init/002_readonly_user.sh`.
  The app only ever connects as this user, via the source's `secret_ref`.

## Migrations

`scripts/migrate.ts` applies `migrations/*.sql` in filename order inside a
transaction, recording each in `schema_migrations` so it runs once. Every
migration declares a rollback or an explicit reason it has none, concurrent
runs serialize on an advisory lock, and `--check` is the pipeline gate against
deploying code ahead of its schema. See
[Database migrations](/operations/migrations/).

---

*Last verified against the code at commit `00ea858` (2026-10-05).*
