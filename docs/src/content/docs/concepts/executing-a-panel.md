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
model-authored SQL. It rejects anything that is not a single read-only statement
against allowlisted tables:

- Must start with `SELECT`/`WITH`; a single statement, no `;` chaining.
- **No comments** (`--`, `/* */`, `#`) — they can smuggle disallowed constructs.
- **Forbidden keywords**: all DML and DDL (`insert`, `update`, `drop`, `alter`, …),
  plus `into`/`outfile`, `set`, `system`, and the SQL time functions
  (`current_date`, `current_timestamp`, `localtime`, …).
- **Forbidden table functions**: anything that could exfiltrate data or bypass
  the allowlist — `file`, `url`, `remote`, `s3`, `postgresql`, `dblink`,
  `pg_read_file`, and friends.
- **Forbidden non-deterministic and time functions**: `now`, `today`, `rand`, …
  The model must not filter or branch on time.
- **`$N` placeholders are reserved** for the server's bound parameters.
- **Table allowlist**: every `FROM`/`JOIN` target must appear in the selected
  source's catalog. Subqueries (`FROM (…)`) are allowed.

If any check fails, the save — or a later tick — reports a clear error instead
of touching the database.

:::caution[This is the whole security boundary]
`validateSql` is currently regex-based. String matching over SQL cannot see
through dollar-quoting, unicode escapes, or constructs it does not tokenize the
way Postgres does. Replacing it with AST validation is tracked as
[#10](https://github.com/jbouder/holotable/issues/10), with fuzzing in
[#11](https://github.com/jbouder/holotable/issues/11).
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
- A hard `LIMIT` caps rows regardless of what the query does.

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
