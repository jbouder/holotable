# Holotable Architecture & Invariants

Holotable turns a natural-language prompt into a live monitoring dashboard. A
language model authors a **validated visualization spec** (SQL + chart config)
— it never touches, produces, or sees metric data. The server executes the
guarded SQL against ClickHouse and streams deltas to the browser.

```
Prompt ─▶ /api/generate ─▶ LLM (streamObject) ─▶ Zod IR spec (validated)
                                                     │ save
                                             Postgres (immutable versions)
Viewer ─▶ SSE /stream ─▶ shared in-process poller ─▶ guarded SQL ─▶ ClickHouse
                                                     └─▶ deltas ─▶ ECharts merge
```

## Layers

| Concern | Location |
| --- | --- |
| Shared IR (single Zod contract) | `src/lib/ir.ts` |
| Group parsing / identity | `src/lib/auth/claims.ts` |
| Centralized authorization (`can`) | `src/lib/auth/authorize.ts` |
| Session token (JWKS RS256 / dev HS256) | `src/lib/auth/session.ts` |
| Config store (Postgres) | `src/lib/db/pg.ts`, `src/lib/db/repo.ts` |
| Source registry (safe config + secret_ref) | `src/lib/registry.ts` |
| Catalog (metadata-only prompt) | `src/lib/clickhouse/catalog.ts` |
| SQL safety + time injection | `src/lib/sql/safety.ts` |
| Metrics execution (read-only) | `src/lib/clickhouse/client.ts` |
| LLM generation | `src/lib/ai/provider.ts`, `src/lib/ai/generate.ts` |
| Shared poller | `src/lib/poller/registry.ts` |
| Charts (setOption merge) | `src/components/charts/*` |

## Core invariants

1. **LLM runs exactly once** — only on author/create/edit, never on view or on a
   poller tick. Viewing and ticking replay the stored spec.
2. **LLM emits a validated spec, never data.** `streamObject` is bound to the
   shared IR (`DashboardGenerationSchema`). Output is re-parsed with Zod before
   it is trusted.
3. **Immutable, versioned specs.** Each save inserts a new `dashboard_versions`
   row containing the whole spec as `jsonb`. Specs are never mutated in place.
4. **Panels carry only a stable `sourceId`.** No connection details, hosts, or
   credentials live in a panel. The registry owns the safe connection config,
   the catalog (table/column allowlist), and a `secret_ref`.
5. **Credentials resolve from the environment** via `secret_ref`
   (`CH_METRICS` → `CH_METRICS_USERNAME` / `CH_METRICS_PASSWORD`). They are
   never stored in the database and never leave the server. The resolved user is
   the read-only ClickHouse user.
6. **Referenced sources are tombstoned, not hard-deleted.** Deleting a source
   that is referenced by any panel sets `tombstoned_at`; panels then surface a
   tombstone state instead of silently breaking.
7. **All model SQL is untrusted.** `validateSql` enforces SELECT/WITH-only, a
   single statement, no comments, a keyword/table-function denylist, a
   catalog-table allowlist, and a ban on time / non-deterministic functions.
8. **The server owns the time range.** `buildExecutablePlan` wraps the validated
   query as a subquery and injects `from`/`to` on the declared `timeField` via
   **bound parameters**, plus `readonly=1`, execution-time and row limits. The
   model cannot filter time or influence resource usage.
9. **The catalog prompt is metadata only** — table and column names/types for a
   **single selected, authorized source per call**. No sample rows are sent.
10. **One poller per dashboard** shared across independently authorized
    subscribers. Each browser opens **one** `EventSource`. The poller executes
    each panel once per tick, tracks a per-panel delta cursor, and broadcasts
    only newer rows (`append`) or full snapshots (`replace`).
11. **Charts merge, never recreate.** `EChart` initializes once and applies
    `setOption(..., { notMerge: false })`; the browser keeps a bounded rolling
    window (`MAX_WINDOW_POINTS`).
12. **SSE is cookie-authenticated.** The stream handler verifies the session
    cookie and re-authorizes the dashboard's workspace before subscribing.
13. **OKLCH design tokens are resolved to RGB/hex** (`src/lib/color/oklch.ts`)
    before being handed to ECharts, which cannot parse `oklch()`.
14. **Every request is authorized from the validated identity.** The source is
    re-resolved and re-authorized on **every** execution (including each poller
    tick). `can()` in `authorize.ts` is the only decision point and the only
    place the platform-admin bypass applies.

## Authorization model

Roles come exclusively from the token's `groups` claim (Keycloak group paths):

```
/workspaces/{workspaceId}/viewer          # read dashboards
/workspaces/{workspaceId}/editor           # create/update/generate dashboards
/workspaces/{workspaceId}/source-admin     # manage sources; delete dashboards
/platform-admins                           # global admin (single sanctioned bypass)
```

- Highest role wins within a workspace (`viewer < editor < source-admin`).
- **Authorization is never derived from a workspace id in a request body.** The
  workspace is taken from a trusted, already-scoped resource
  (`source.workspaceId`, `dashboard.workspaceId`) or, for list/create, checked
  against the identity for the requested workspace.
- Dashboard list/get → viewer; create/update/generate → editor;
  delete → owner, source-admin, or platform-admin.
- Source CRUD / test / refresh → source-admin.

## Open decision: AI provider/model

The provider and model are **environment-selected**; no model catalog or
model-specific data is baked into the code (`src/lib/ai/provider.ts`):

- `AI_PROVIDER=gateway` — the bare `AI_MODEL` string is routed by the AI SDK
  Gateway (`AI_GATEWAY_API_KEY`).
- `AI_PROVIDER=openai-compatible` — an OpenAI-compatible endpoint via
  `OPENAI_BASE_URL` + `OPENAI_API_KEY`.

Choosing the concrete provider/model is deliberately left to the deployment.
`AI_MODEL` must be set; there is no default model.

## Single-instance poller caveat

The poller lives in the Node process (`src/lib/poller/registry.ts`). It is
correct and efficient for a **single app instance**: one poller per dashboard,
shared by all subscribers on that instance. Running multiple app replicas would
create one poller per replica (duplicated ClickHouse polling; no cross-instance
delta sharing). To scale horizontally, move the poller behind a shared runtime
(e.g. a dedicated poller service or a pub/sub fan-out such as Redis) and have
web instances subscribe to it rather than poll directly. The delta-cursor and
broadcast logic (`computeDelta`, the executor abstraction) are already isolated
to make that extraction straightforward.

## Data model (Postgres)

- `sources` — registry: safe `config` (jsonb), `secret_ref`, `workspace_id`,
  `tombstoned_at`.
- `dashboards` — `workspace_id`, `title`, `created_by`, `deleted_at`.
- `dashboard_versions` — append-only: `dashboard_id`, `version`, `spec` (jsonb).

## Metrics model (ClickHouse)

- `http_requests` — raw request events (see `clickhouse/init/001_schema.sql`).
- An `AggregatingMergeTree` materialized view pre-aggregates per-minute stats.
- A **read-only** user is created by `clickhouse/init/002_readonly_user.sh`; the
  app only ever connects as this user via the source `secret_ref`.
