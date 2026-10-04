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

`streamObject` is bound to the shared IR (`DashboardGenerationSchema`, which is
the `Dashboard` schema without `specVersion`: the version is stamped by the
app, never asserted by the model). Output is re-parsed with Zod before it is
trusted.

## 3. Specs are immutable and versioned

Each save inserts a new `dashboard_versions` row containing the whole spec as
`jsonb`. Specs are never mutated in place.

Every spec records the IR version it was written in as `specVersion`, and
`Dashboard` accepts only the current one (`SPEC_VERSION` in `src/lib/ir.ts`).
A breaking IR change bumps that number and appends an upgrader, a pure
function from version N to N+1, to `src/lib/ir/upgrade.ts`. Anything that
reads a spec it did not just build reads it through `StoredDashboard`: a
version row, a template, an export file, a browser draft, or a save from a tab
opened before a deploy. That applies the chain in memory and then validates.
A spec with no `specVersion` predates the field and is version 1. Reads never
write back, so a row keeps the version it was saved at and the next save writes
the current one. A spec from a newer build is refused rather than guessed at.

## 4. Panels carry only a stable `sourceId`

No connection details, hosts, or credentials live in a panel. The registry owns
the safe connection config, the catalog (the table and column allowlist), and a
`secret_ref`.

## 5. Credentials resolve from the environment

Via `secret_ref`: `TS_METRICS` resolves `TS_METRICS_USERNAME` /
`TS_METRICS_PASSWORD`, as files in `SOURCE_SECRETS_DIR` or from the
environment. They are never stored in the database and never leave the server.
The resolved user is the read-only TimescaleDB role.

A ref resolves only for a workspace `SOURCE_SECRET_REFS` grants it to, and
unset grants nothing. The grant is checked in `resolveCredentials`
(`src/lib/secrets/credentials.ts`) on every connection, not only when a source
is saved, so one workspace cannot use another's database role by naming its
ref. See [Source secret references](/operations/secret-references/).

## 6. Referenced sources are tombstoned, not hard-deleted

Deleting a source referenced by any panel sets `tombstoned_at`; panels then
surface a tombstone state instead of silently breaking.

## 7. All model SQL is untrusted

`validateSql` parses every statement with the real PostgreSQL grammar and
walks the tree: exactly one SELECT, built only from allowlisted node types, no
other statement anywhere in the tree, no `SELECT INTO`, no row locking, no
comments. Every relation the tree reads is checked against the catalog
allowlist, every function it calls against a denylist, and time and
non-deterministic functions, keywords and literals are banned. See
[Executing a panel](/concepts/executing-a-panel/).

The function denylist spans dialects on purpose. Entries in ClickHouse vocabulary cost
nothing against a PostgreSQL target and mean a future driver inherits them, but
the PostgreSQL entries are the ones doing work today. Two groups matter most:

- **Functions that take a query string and execute it** — `query_to_xml` and
  the rest of the `*_to_xml` family. The catalog allowlist never sees the
  tables these reach, and the application's read-only role holds `SELECT` on
  the whole metrics schema rather than only the catalog tables, so this is an
  allowlist bypass rather than an information leak.
- **Every synonym for the current time**, not just `now()` — see invariant 8.

Relation names are compared against the catalog exactly, character for
character, as the parser reports them: an unquoted identifier is already
folded to lowercase, a quoted one keeps its case. `HTTP_REQUESTS` is the
catalog table `http_requests`; `"HTTP_REQUESTS"` is a different relation and
is rejected.

Statement shape and table access are decided from the parse tree, so the
guard sees through dollar-quoting, unicode escapes, nested CTEs and
subqueries in any position, and it recognises a CTE alias, `FROM` inside
`extract()`, and a keyword inside a string literal for what they are. The
function check is still a list of names, and a list can only block what it
has been told about. `test/sql-safety-postgres.test.ts` and
`test/sql-safety-ast.test.ts` pin both sides — what is blocked, and what the
regex guard used to block wrongly. `test/sql-safety.fuzz.test.ts` goes past the
cases anyone wrote down: it generates statements from a grammar of adversarial
shapes — every spelling of a forbidden function, every quoting of a time word,
tables in every position a relation can appear, writes inside CTEs, scoping
tricks, comments, casing, whitespace — and checks that everything poisoned is
rejected, everything benign is accepted, and everything accepted satisfies an
independent walk of the parse tree.

## 8. The server owns the time range

Blocking `now()` and `current_timestamp` is not sufficient on PostgreSQL:
`clock_timestamp()`, `statement_timestamp()`, `transaction_timestamp()` and
`timeofday()` all return a clock reading, and the first is not even stable
within a single statement. All of them are denied, alongside the
non-deterministic value functions (`random()`, `gen_random_uuid()`) that would
let the same spec produce a different query on each poller tick.

`buildExecutablePlan` wraps the validated query as a subquery and injects
`from`/`to` on the declared `timeField` via **bound parameters**, plus a
read-only transaction and execution-time, row, and result-byte limits. The
model controls neither the time window nor resource usage. Each execution also pins
`search_path` to the source's configured schema — a validated bare identifier —
plus `public`, so unqualified table names resolve only against the allowlisted
schema.

`POST /api/sources/[id]/test` is where that claim is *checked* rather than
assumed (#126). Inside the same read-only transaction, it attempts a harmless
write — `CREATE TEMP TABLE` — and reports whether the server refused it with
SQLSTATE `25006`. The refusal is the expected outcome; a write that **succeeds**
means the configured role is more privileged than everything above assumes, and
the test says so as a finding rather than showing a tick. The probe runs in a
savepoint inside a transaction that is always rolled back, and Postgres makes
DDL transactional, so it cannot leave anything behind even in the case where
the server allows it.

## 8a. A row-filtered source returns only the viewer's rows

The time window is not the only predicate the server owns. A source with a
`rowFilter` (#31) narrows **every table a statement reads** to the rows whose
filter column equals the viewer's claim. The predicate is applied where each
table is read, not on the wrapper that carries the time bounds, because a
wrapper predicate filters only the output, and the output can claim any
tenant. `applyRowFilter` (`src/lib/sql/row-filter.ts`) replaces each real-table
reference, found with the guard's own CTE scoping, with
`(SELECT * FROM t AS _holo_rf WHERE _holo_rf.<column> = $n)`. It then
re-parses its own output and refuses any statement it cannot prove is fully
narrowed. The value is a bound parameter read from the verified identity
(`bindRowFilter`), never from the request or the model.

`buildExecutablePlan` takes `rowFilter` as a **required** input, `null` only
for a source without one, so a call site cannot leave it out. A viewer without
the claim is refused, never served unfiltered, and that includes a platform
admin. Pollers are keyed by the claim values they run with, so tenants never
share one. See [Row-level filters](/operations/row-level-filters/).

## 9. The catalog prompt is metadata only, and that metadata is untrusted

Table and column names and types for a **single selected, authorized source per
call**. No sample rows are sent, and no column the catalog marks
`"exposed": false`: the guard refuses any read of one, so naming it to the
model would only produce SQL that fails.

The names come from `information_schema.columns` of a database the operator may
not control, and a column called `-- ignore previous instructions` is a prompt
injection aimed at every generation path. So the catalog enters a prompt only
through `renderCatalog` and `fenceUntrustedBlock` (`src/lib/ai/untrusted.ts`):
every field is flattened onto one line, stripped of control characters and
clamped to its registry-schema maximum, and the whole block sits between
markers carrying a random per-call token, preceded by a standing rule that the
contents are data. The body is scrubbed of the token, so no name or
description can close the block or open a fake one. The dashboard chat prompt
treats the stored panel specs (titles, descriptions, SQL written by an earlier
model run) the same way. This is a second line of defence: the model's output
is untrusted regardless (invariant 7), which is what actually contains a
successful injection.

## 10. One poller per dashboard

Shared across independently authorized subscribers. Each browser opens **one**
`EventSource`. The poller executes each panel once per tick, keeps a delta
cursor per subscriber and panel, and sends each subscriber only the rows newer
than its cursor (`append`) or full snapshots (`replace`). A subscriber that
joins or resumes is caught up from the last results without another query.

## 11. Charts merge, never recreate

`EChart` initializes once and applies `setOption(..., { notMerge: false })`; the
browser keeps a bounded rolling window (`MAX_WINDOW_POINTS`).

## 12. SSE is cookie-authenticated

The stream handler verifies the session cookie and re-authorizes the dashboard's
workspace before subscribing. The stream then stays authorized only as long as
that session: it ends at the token's expiry and on revocation, and every
`SSE_REAUTH_INTERVAL_MS` the token is verified again and the dashboard
re-authorized (#32, `src/lib/auth/stream-guard.ts`).

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
— bad column, syntax, type mismatch, timeout, missing `timeField`, a result
over `MAX_RESULT_BYTES`. Routes
translate it to a `400` with the real message so an editor can fix and retry;
connection and socket failures stay a generic `500` and are never surfaced.

The split is carried, not inferred. Every error body names a `kind`
(`src/lib/errors.ts`), and the SSE path honours it too: a `panel-error` frame
carries the real message only for a statement failure, and
`describePanelError` reduces anything else to the generic sentence with the
cause going to the log. `describeTickError` makes the same split for a
`dashboard-error`: a `TimeRangeError` keeps its message because the range is
the one part of the spec a viewer picks, and everything else is opaque. The client decides presentation from `kind` alone —
`presentError` discards the message on the opaque path regardless of what
arrived, so a careless server change cannot turn into a disclosure.

## 17. Every model call is rate limited and budgeted, server-side

The three routes that call the model run `enforceLlmLimits`
(`src/lib/limits/llm.ts`) right after `assertAuthorized`: a per-user token
bucket, then a per-workspace daily token budget read back from `llm_usage`.
Over either, the request is a `429` naming the limit and its reset before the
model is invoked. Keys come from the validated identity and a trusted record,
never the request body, and platform admins are not exempt. See
[LLM rate limits and budgets](/operations/llm-limits/).

## 18. Every change and every refusal is audited, and the audit log is append-only

Each event in `AUDIT_ACTIONS` (`src/lib/audit.ts`) writes one `audit_log` row
naming the verified actor, the workspace the action was authorized in, the
action and its outcome; `assertAuthorized` writes one for every refusal. Rows
are built by `auditRow` alone, which runs `detail` through the log's redaction
pass and drops anything shaped like a result, so no credential and no metric
value is stored. The table's triggers refuse `UPDATE`, `DELETE` and `TRUNCATE`
for every role. Writing never blocks or fails the request it describes. See
[Audit log](/operations/audit-log/).
