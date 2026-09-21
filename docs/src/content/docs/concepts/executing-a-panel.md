---
title: Executing a panel
description: Validation, immutable storage, the SQL guard, and server-owned time injection.
sidebar:
  order: 4
---

## Validation and storage — the spec becomes a version

When the user saves, the client posts the spec to `/api/dashboards`. The server
does **not** trust the streamed object; it re-parses and re-validates from
scratch.

`resolveAndValidateDashboard` (`src/lib/dashboard-service.ts`) is the gate:

- Every referenced `sourceId` must resolve to a real, non-tombstoned source.
- **All panels must belong to one workspace**, derived from the trusted source
  records — mixing workspaces is rejected.
- **Every panel's SQL is re-run through `validateSql`** against *its own
  source's catalog*. Generation-time validity is not assumed; the source is
  re-authorized and the SQL re-checked at save.

The derived workspace then authorizes `dashboard:create`, and the spec is
written as a new immutable row. Specs are **never mutated in place** — an edit
inserts a new version. That is what lets viewing and polling be pure replays of
a fixed spec, and it means a saved dashboard is a stable, auditable artifact.
See [Data model](/architecture/data-model/).

## The SQL guard

`validateSql` (`src/lib/sql/safety.ts`) is the trust boundary for
model-authored SQL. It parses the statement with the real PostgreSQL grammar
(`libpg_query`, compiled to WebAssembly, wrapped in `src/lib/sql/ast.ts`) and
walks the tree. It rejects anything that is not a single read-only statement
against allowlisted tables:

- **Exactly one statement, and it is a `SELECT`.** Anything the parser cannot
  parse is rejected. Any other statement type anywhere in the tree — `INSERT`
  inside a CTE, `EXPLAIN`, `COPY`, `MERGE`, `SET` — is rejected by type, not by
  keyword.
- **Only allowlisted node types.** The walker knows the constructs a read-only
  SELECT is built from; a construct it has not been told about is rejected by
  name. `SELECT INTO`, row locking (`FOR UPDATE`/`FOR SHARE`) and `$N`
  placeholders — reserved for the server's bound parameters — get their own
  errors.
- **No comments.** The lexer decides, so `'--'` inside a string literal is fine.
- **Forbidden functions**: anything that could exfiltrate data or bypass the
  allowlist — `file`, `url`, `remote`, `s3`, `dblink`, `pg_read_file`, the
  `*_to_xml` family that executes a query string — plus server-side sleeps,
  session state, server identity, advisory locks and backend signals. Matched
  by unqualified name against every call in the tree, in any position, so
  `pg_catalog.pg_sleep(1)` is caught.
- **Forbidden time and non-deterministic values**: `now()` and every synonym,
  `random()`, the parenless keywords (`current_timestamp`, `current_user`, …)
  and the date/time input words (`'now'`, `'today'`, `'yesterday'`) that
  PostgreSQL reads as the clock. The model must not filter or branch on time.
- **Table allowlist**: every relation the tree reads must appear in the selected
  source's catalog — in the top-level `FROM`, a nested CTE, a lateral subquery,
  a set-operation arm, or a `LIMIT` expression alike. CTE names are resolved
  with PostgreSQL's scoping rules first, so `FROM b` after `WITH b AS (…)` is
  the CTE, while a name a later or sibling CTE defines is a real table.

The function denylists also run over the raw text after the parse-tree pass, as
a cheap second layer that does not depend on the parser.

If any check fails, the save — or a later tick — reports a clear error instead
of touching the database.

:::caution[This is the whole security boundary]
Statement shape and table access are decided from the parse tree. Which
*functions* may be called is still decided by name against a list, and a list
can only block what it has been told about. Generative testing of the guard is
tracked in [#11](https://github.com/jbouder/holotable/issues/11).
:::

## The server owns time

Real data enters the system only here — server-side, from a stored spec. Three
places share the same guard code: the live poller, the one-shot query route, and
the read-only dashboard chat's `runQuery` tool. The core is
`buildExecutablePlan`, which runs **after** `validateSql` has passed.

The validated query is wrapped as a subquery, and the dashboard's resolved
`from`/`to` are injected as **bound parameters** on the declared `timeField`:

```sql
SELECT * FROM (<the model's validated SQL>) AS _holo
WHERE _holo.<timeField> >= $1::timestamptz
  AND _holo.<timeField> <  $2::timestamptz
LIMIT <maxQueryRows>          -- default 5000
```

- `from`/`to` come from `resolveTimeRange` (`src/lib/time.ts`), which turns the
  IR's relative expressions (`now-1h`) into concrete dates. The model never
  supplies a time value; it only named the column.
- `timeField` is re-checked against a strict identifier regex before
  interpolation — it is an identifier, so it cannot be a bound parameter.
- A hard `LIMIT` caps rows regardless of what the query does, and
  `MAX_RESULT_BYTES` (default 4 MiB) caps the serialized size of the result:
  `executePlan` measures rows as they stream in from Postgres and stops
  keeping them the moment the cap is crossed, so a wide-row result fails with
  an actionable message naming the limit instead of being buffered whole.

## Read-only execution

`executePlan` (`src/lib/timescaledb/client.ts`) runs the plan in a **read-only
transaction** as the source's read-only role, with a statement timeout
(`QUERY_TIMEOUT_SECONDS`, default 20s). Inside the transaction it first pins
`SET LOCAL search_path` to the source's configured schema — validated as a bare
identifier — plus `public`, so the catalog's bare table names resolve only
against the allowlisted schema. Credentials are resolved from the environment
via the source's `secret_ref`; they are never stored in the spec and never leave
the server.

Net effect: the model controls *what to compute*, but not the time window, not
resource usage, and not which credentials or tables it can touch.

## Actionable errors versus opaque ones

When a statement fails, `executePlan` distinguishes **statement-level** errors —
Postgres SQLSTATE codes for a bad column, syntax, type mismatch, timeout, or a
`timeField` naming no output column — from connection and infrastructure errors.

The former are wrapped as `QueryExecutionError`, and routes return them as a
`400` carrying the real message so an editor can correct and retry. Infrastructure
errors stay a generic `500` and are never surfaced.

The missing-`timeField` case gets a purpose-written message, because the generic
Postgres error (`column _holo.minute does not exist`) does not explain the fix:

> time column "minute" is not produced by this query. Set the panel's timeField
> to the SELECT output alias of your time bucket (e.g. `time_bucket(...) AS
> minute`), or clear it when the result has no time column.
