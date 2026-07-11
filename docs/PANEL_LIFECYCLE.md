# The Life of a Panel

This document traces a single panel end to end: how it is **generated** by the
LLM, **validated** and **stored**, and finally **executed** and **rendered** as
a live chart. It is the narrative companion to [`ARCHITECTURE.md`](./ARCHITECTURE.md),
which lists the invariants; here we follow one panel through them.

The one idea to hold onto: **the model authors a spec, never data.** A panel is
a small, validated description of *what to compute and how to draw it*. Real
metric values are only ever produced by the server executing guarded SQL against
TimescaleDB — at author time and on every refresh tick thereafter.

```
                 author once                         replay forever
  ┌──────────────────────────────────┐   ┌──────────────────────────────────┐
  Prompt ─▶ /api/generate ─▶ LLM ─▶ IR spec ─▶ validate ─▶ Postgres (jsonb)
                                                                  │
                                                                  ▼
  Browser ◀─ ECharts merge ◀─ SSE ◀─ poller ◀─ guarded SQL ◀─ stored spec
```

---

## What a panel *is*

A panel is one object in the shared Zod IR (`src/lib/ir.ts`). Its entire
contract:

```ts
Panel = {
  id: string,                 // unique within the dashboard
  title: string,
  description?: string,       // intent only, populated for ad-hoc exploration
  viz: "line" | "bar" | "stat" | "table" | "heatmap",
  query: {
    sourceId: string,         // opaque reference into the source registry
    sql: string,              // UNTRUSTED SELECT — validated before it ever runs
    timeField?: string,       // the column the SERVER filters time on
  },
  format?: "number" | "bytes" | "percent" | "ms",
  layout: { x, y, w, h },     // position on a 12-column grid
}
```

Three properties of this shape carry the whole security model:

- **`sourceId` is opaque.** No host, port, database, or credential ever lives in
  a panel. The source registry (`src/lib/registry.ts`) owns the safe connection
  config, the table/column allowlist (the *catalog*), and a `secret_ref` that
  resolves credentials from the environment at execution time.
- **`sql` is untrusted** even though the model wrote it. It is re-validated on
  every save and on every execution — never trusted because "we generated it."
- **There is no time filter in the query.** The model is explicitly forbidden
  from filtering time. `timeField` merely *names* the column; the **server**
  injects the `from`/`to` bounds. Time authority never leaves the server.

The same `Panel` schema is the LLM's output type, the API's validation type, the
persisted type, and the client's render type. There is exactly one definition,
so the contract cannot drift.

---

## 1. Generation — the model authors a spec

Entry point: `POST /api/generate` (`src/app/api/generate/route.ts`).

The request body is a discriminated union over three `mode`s:

| Mode | Produces | Used by |
| --- | --- | --- |
| `dashboard` | a full `Dashboard` (1–50 panels) | new-dashboard flow |
| `panel` | one updated `Panel` from a current panel + NL edit | per-panel "edit with AI" |
| `explore` | one `Panel` answering an ad-hoc question | the Explore tool |

Before any model call, the route:

1. **Resolves identity** (`requireIdentity`).
2. **Loads the source** by `sourceId` and rejects it if missing or tombstoned.
3. **Authorizes** `dashboard:generate` against the workspace that *owns the
   source* — the workspace is taken from the trusted source record, never from
   the request body.

Only then does it hand off to `src/lib/ai/generate.ts`, which uses the AI SDK's
`streamObject` bound to the Zod IR:

```ts
streamObject({
  model: getModel(),               // env-selected provider/model
  schema: Dashboard,               // or Panel — the model's output IS the IR
  system: baseSystem(source),      // catalog metadata + strict SQL rules
  prompt: ...,
})
```

Two things make this safe by construction:

- **`schema` binds the output to the IR.** The model is structurally constrained
  to emit a spec shaped like `Dashboard`/`Panel`, not free-form text and not data
  rows.
- **The system prompt contains only catalog *metadata*** for the single selected
  source — table and column names and types from `buildCatalogPrompt(source)`.
  No sample rows are ever sent to the model. It designs against a schema, not
  against data.

The `SQL_RULES` block in the prompt tells the model the house rules: SELECT-only,
no semicolons/comments, reference only allowlisted tables, **never** write a time
filter or `now()`, and for time-series always `GROUP BY` a time bucket, alias it,
set it as `timeField`, and `ORDER BY` it ascending. These rules are a courtesy to
the model — every one of them is independently *enforced* downstream, so a model
that ignores them produces a spec that fails validation rather than an unsafe
query.

`streamObject` streams the partial object to the client so the UI can render the
spec as it forms. **The model runs exactly once per author action** — never on
view, never on a refresh tick.

---

## 2. Validation & storage — the spec becomes a version

When the user saves, the client `POST`s the spec to `/api/dashboards`
(`src/app/api/dashboards/route.ts`). The server does **not** trust the streamed
object; it re-parses and re-validates from scratch.

**`resolveAndValidateDashboard`** (`src/lib/dashboard-service.ts`) is the gate:

- Every referenced `sourceId` must resolve to a real, non-tombstoned source.
- **All panels must belong to one workspace**, derived from the trusted source
  records — mixing workspaces is rejected.
- **Every panel's SQL is re-run through `validateSql`** against *its own source's
  catalog*. Generation-time validity is not assumed; the source is re-authorized
  and the SQL re-checked at save.

The derived workspace then authorizes `dashboard:create`, and the spec is written
as a new immutable row:

- `dashboards` — identity: `workspace_id`, `title`, `created_by`, `deleted_at`.
- `dashboard_versions` — **append-only**: `dashboard_id`, `version`, and the
  entire spec as `jsonb`.

Specs are **never mutated in place**. An edit inserts a new version. This is what
lets viewing and polling be pure replays of a fixed spec, and it means a saved
dashboard is a stable, auditable artifact.

### The SQL guard (`src/lib/sql/safety.ts`)

`validateSql` is the trust boundary for model-authored SQL. It rejects anything
that is not a single read-only statement against allowlisted tables:

- Must start with `SELECT`/`WITH`; a single statement (no `;` chaining).
- **No comments** (`--`, `/* */`, `#`) — they can smuggle disallowed constructs.
- **Forbidden keywords**: all DML/DDL (`insert`, `update`, `drop`, `alter`, …),
  plus `into`/`outfile`, `set`, `system`, and the SQL time functions
  (`current_date`, `current_timestamp`, `localtime`, …).
- **Forbidden table functions**: anything that could exfiltrate or bypass the
  allowlist — `file`, `url`, `remote`, `s3`, `postgresql`, `dblink`,
  `pg_read_file`, etc.
- **Forbidden non-deterministic/time functions**: `now`, `today`, `rand`, … The
  model must not filter or branch on time.
- **`$N` placeholders are reserved** for the server's bound parameters.
- **Table allowlist**: every `FROM`/`JOIN` target must appear in the selected
  source's catalog (subqueries `FROM (…)` are allowed).

If any check fails, the save (or a later tick) reports a clear error instead of
touching the database.

---

## 3. Execution — the server turns a spec into rows

This is where real data enters the system — server-side only, from a stored
spec. It happens in two places that share the same guard code: the live poller
(§4) and the one-shot query route. The core is `buildExecutablePlan`
(`src/lib/sql/safety.ts`), which runs **after** `validateSql` has passed.

The server owns time. The validated query is wrapped as a subquery, and the
dashboard's resolved `from`/`to` are injected as **bound parameters** on the
declared `timeField`:

```sql
SELECT * FROM (<the model's validated SQL>) AS _holo
WHERE _holo.<timeField> >= $1::timestamptz
  AND _holo.<timeField> <  $2::timestamptz
LIMIT <maxQueryRows>          -- default 5000
```

- `from`/`to` come from `resolveTimeRange` (`src/lib/time.ts`), which turns the
  IR's relative expressions (`now-1h`) into concrete `Date`s. The model never
  supplies a time value; it only named the column.
- `timeField` is re-checked against a strict identifier regex before
  interpolation (it's an identifier, so it can't be a bound param).
- A hard `LIMIT` caps rows regardless of what the query does.

`executePlan` (`src/lib/timescaledb/client.ts`) runs this in a **read-only
transaction** as the source's read-only role, with a statement timeout
(`QUERY_TIMEOUT_SECONDS`, default 20s). Credentials are resolved from the
environment via the source's `secret_ref` — they are never stored in the spec
and never leave the server.

Net effect: the model controls *what to compute*, but not the time window, not
resource usage, and not which credentials or tables it can touch.

---

## 4. Live delivery — one poller, many viewers

Opening a dashboard (`src/app/dashboards/[id]/page.tsx`) authorizes
`dashboard:view` and renders `LiveDashboard`, which opens **exactly one**
`EventSource` to `/api/dashboards/[id]/stream`.

**Server side** (`.../stream/route.ts` + `src/lib/poller/registry.ts`):

- The SSE handler re-authorizes the subscriber against the dashboard's workspace
  (SSE is cookie-authenticated), then attaches to the **shared poller** for that
  dashboard. `getPoller` guarantees **one poller per dashboard**, shared across
  all subscribers; a newer saved version replaces the old poller.
- Each tick (`max(minRefreshIntervalMs, spec.refreshIntervalMs)`), the poller
  executes **every panel once** via `makePanelExecutor`. For each panel it:
  1. **Re-resolves the source every tick.** If the source is missing,
     tombstoned, or belongs to a *different* workspace than the dashboard, it
     emits a `tombstone` event (all three cases look identical, so a crafted spec
     can't probe cross-workspace sources).
  2. Re-runs `validateSql`, builds the guarded plan (§3), executes it.
  3. **Computes a delta.** For time-series panels (`computeDelta`) it tracks the
     last emitted timestamp per panel and broadcasts only newer rows as an
     `append`. Non-time panels are sent as a full `replace` snapshot.

Events are broadcast to every subscriber's SSE stream. The event types are:
`panel` (`append`/`replace`), `panel-error`, `tombstone`, and `tick`.

> **Scaling caveat:** the poller lives in the Node process, so it is correct for
> a *single* app instance. Multiple replicas would each run their own poller. See
> the single-instance poller note in `ARCHITECTURE.md`.

---

## 5. Rendering — merge, never recreate

**Client side** (`LiveDashboard.tsx` → `PanelView.tsx` → `EChart.tsx`):

`LiveDashboard` fans SSE events out to per-panel React state:

- `append` rows are concatenated into a **bounded rolling window**
  (`MAX_WINDOW_POINTS`, default 720) — old points fall off the front.
- `replace` swaps the window; `panel-error` and `tombstone` flip panel status.
- A **staleness watchdog** marks panels `stale` if no `tick` arrives within ~2
  refresh intervals (also on `EventSource` transport error, which auto-reconnects).

`PanelView` picks a renderer from `panel.viz`:

- `stat` → the last numeric value, run through `formatValue` per `panel.format`.
- `table` → an HTML table of the windowed rows.
- `line` / `bar` / `heatmap` → `buildChartOption` (`src/components/charts/options.ts`)
  builds an ECharts option, drawn by `EChart`.

`EChart` is the invariant that keeps charts smooth: the ECharts instance is
created **once** and every update is `setOption(option, { notMerge: false })`.
The chart **merges** incoming data into the existing series — it is never torn
down and recreated on a data tick, so streaming feels continuous.

One rendering detail worth knowing: design tokens are authored in **OKLCH**, but
ECharts cannot parse `oklch()`. `chartPalette()` (`src/lib/color/oklch.ts`)
resolves tokens to RGB/hex before they reach any chart option.

---

## The whole trip, in one breath

1. A user describes what they want. `/api/generate` authorizes against the
   source's workspace and the LLM authors a **validated IR spec** — once.
2. On save, every panel's source and SQL are **re-validated**, the workspace is
   derived from trusted sources, and the spec is written as an **immutable,
   versioned** `jsonb` row.
3. To view, the browser opens **one SSE stream** and attaches to the **one
   shared poller** for that dashboard.
4. Each tick, the server re-resolves the source, re-validates the SQL, injects
   its **own time range** via bound parameters, and executes **read-only** SQL —
   producing the only real data in the system.
5. The poller broadcasts **deltas**; the browser **merges** them into a bounded
   window and ECharts updates in place.

The model designed the panel. The server, from then on, is the only thing that
ever runs it.

---

## Where to look in the code

| Stage | Files |
| --- | --- |
| IR contract | `src/lib/ir.ts` |
| Generate route + auth | `src/app/api/generate/route.ts` |
| LLM generation | `src/lib/ai/generate.ts`, `src/lib/ai/provider.ts` |
| Catalog (prompt metadata) | `src/lib/timescaledb/catalog.ts` |
| Save + validate | `src/app/api/dashboards/route.ts`, `src/lib/dashboard-service.ts` |
| SQL guard + time injection | `src/lib/sql/safety.ts` |
| Time resolution | `src/lib/time.ts` |
| Execution (read-only) | `src/lib/timescaledb/client.ts` |
| Poller + deltas | `src/lib/poller/registry.ts` |
| SSE stream | `src/app/api/dashboards/[id]/stream/route.ts` |
| Live client | `src/components/dashboard/LiveDashboard.tsx`, `PanelView.tsx` |
| Charts | `src/components/charts/EChart.tsx`, `options.ts`, `src/lib/color/oklch.ts` |
