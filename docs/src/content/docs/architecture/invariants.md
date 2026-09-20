---
title: Invariants
description: The numbered guarantees the Holotable design rests on, and where each is enforced.
sidebar:
  order: 1
---

These are the properties the system preserves. They are enforced in code, not
conventions — a change that breaks one of them is a bug, not a trade-off.

## 1. The LLM runs exactly once

Only on author, create, or edit — never on view, and never on a poller tick.
Viewing and ticking replay the stored spec.

## 2. The LLM emits a validated spec, never data

`streamObject` is bound to the shared IR (`DashboardGenerationSchema`). Output is
re-parsed with Zod before it is trusted.

## 3. Specs are immutable and versioned

Each save inserts a new `dashboard_versions` row containing the whole spec as
`jsonb`. Specs are never mutated in place.

## 4. Panels carry only a stable `sourceId`

No connection details, hosts, or credentials live in a panel. The registry owns
the safe connection config, the catalog (the table and column allowlist), and a
`secret_ref`.

## 5. Credentials resolve from the environment

Via `secret_ref`: `TS_METRICS` resolves `TS_METRICS_USERNAME` /
`TS_METRICS_PASSWORD`. They are never stored in the database and never leave the
server. The resolved user is the read-only TimescaleDB role.

## 6. Referenced sources are tombstoned, not hard-deleted

Deleting a source referenced by any panel sets `tombstoned_at`; panels then
surface a tombstone state instead of silently breaking.

## 7. All model SQL is untrusted

`validateSql` enforces SELECT/WITH-only, a single statement, no comments, a
keyword and table-function denylist, a catalog-table allowlist, and a ban on
time and non-deterministic functions. See
[Executing a panel](/concepts/executing-a-panel/).

The denylist spans dialects on purpose. Entries in ClickHouse vocabulary cost
nothing against a PostgreSQL target and mean a future driver inherits them, but
the PostgreSQL entries are the ones doing work today. Two groups matter most:

- **Functions that take a query string and execute it** — `query_to_xml` and
  the rest of the `*_to_xml` family. The catalog allowlist never sees the
  tables these reach, and the application's read-only role holds `SELECT` on
  the whole metrics schema rather than only the catalog tables, so this is an
  allowlist bypass rather than an information leak.
- **Every synonym for the current time**, not just `now()` — see invariant 8.

A denylist over raw text is a floor, not a ceiling. It over-rejects (`FROM`
inside `extract()`, a CTE alias, a keyword inside a string literal) and it can
only block what it has been told about. `test/sql-safety-postgres.test.ts`
pins both sides — what is blocked and what is wrongly blocked — so the move to
AST validation has a characterization to work against.

## 8. The server owns the time range

Blocking `now()` and `current_timestamp` is not sufficient on PostgreSQL:
`clock_timestamp()`, `statement_timestamp()`, `transaction_timestamp()` and
`timeofday()` all return a clock reading, and the first is not even stable
within a single statement. All of them are denied, alongside the
non-deterministic value functions (`random()`, `gen_random_uuid()`) that would
let the same spec produce a different query on each poller tick.

`buildExecutablePlan` wraps the validated query as a subquery and injects
`from`/`to` on the declared `timeField` via **bound parameters**, plus a
read-only transaction and execution-time and row limits. The model controls
neither the time window nor resource usage. Each execution also pins
`search_path` to the source's configured schema — a validated bare identifier —
plus `public`, so unqualified table names resolve only against the allowlisted
schema.

## 9. The catalog prompt is metadata only

Table and column names and types for a **single selected, authorized source per
call**. No sample rows are sent.

## 10. One poller per dashboard

Shared across independently authorized subscribers. Each browser opens **one**
`EventSource`. The poller executes each panel once per tick, tracks a per-panel
delta cursor, and broadcasts only newer rows (`append`) or full snapshots
(`replace`).

## 11. Charts merge, never recreate

`EChart` initializes once and applies `setOption(..., { notMerge: false })`; the
browser keeps a bounded rolling window (`MAX_WINDOW_POINTS`).

## 12. SSE is cookie-authenticated

The stream handler verifies the session cookie and re-authorizes the dashboard's
workspace before subscribing.

## 13. OKLCH tokens are resolved before reaching ECharts

`src/lib/color/oklch.ts` converts design tokens to RGB/hex, because ECharts
cannot parse `oklch()`.

## 14. Every request is authorized from the validated identity

The source is re-resolved and re-authorized on **every** execution, including
each poller tick. `can()` in `src/lib/auth/authorize.ts` is the only decision
point and the only place the platform-admin bypass applies.

## 15. Dashboard chat is read-only

`/api/dashboards/[id]/chat` authorizes `dashboard:view` and exposes the model a
single `runQuery` tool, scoped to sources the dashboard already references and
the caller may use. It runs the same validate → plan → execute pipeline, injects
the dashboard's own time range, caps rows and steps, and cannot mutate the
dashboard.

## 16. Statement errors are actionable; infrastructure errors are opaque

`executePlan` raises `QueryExecutionError` for Postgres statement-level failures
— bad column, syntax, type mismatch, timeout, missing `timeField`. Routes
translate it to a `400` with the real message so an editor can fix and retry;
connection and socket failures stay a generic `500` and are never surfaced.
