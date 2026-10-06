# The SQL rules

Every query (panel or variable) is untrusted and passes the guard in
`src/lib/sql/safety.ts` before it runs, against the catalog of the source its
`sourceId` names. It is parsed with the real PostgreSQL grammar, so these rules
are about the parse tree, not the spelling. `examples/sql.json` has one
accepted and one rejected statement per rule, each checked by a test against
`examples/catalog.json`; the error text below is what the guard returns.

## What is refused, and the error you will see

| Rule | Error contains |
|---|---|
| Anything but one SELECT (or WITH … SELECT): no INSERT, UPDATE, DELETE, DDL, and no write inside a CTE | `only SELECT/WITH queries are allowed` |
| More than one statement | `multiple statements are not allowed` |
| Comments, `--` or `/* */` | `comments are not allowed` |
| A time filter or clock reading: `now()`, `clock_timestamp()`, `statement_timestamp()`, `transaction_timestamp()`, `timeofday()`, `age()` | `disallowed function now(): the server owns the time range…` |
| A parenless clock or identity keyword: `current_timestamp`, `current_date`, `localtime`, `current_user`, `current_schema`, … | `disallowed keyword: current_timestamp` |
| A time literal: `'now'`, `'today'`, `'tomorrow'`, `'yesterday'` | `disallowed time literal 'now'` |
| Non-determinism: `random()`, `gen_random_uuid()`, … | `disallowed function random()` |
| Exfiltration, side effects and server identity: `pg_sleep`, `pg_read_file`, `lo_import`, `dblink`, `query_to_xml`, `current_setting`, `set_config`, `version()`, `inet_server_addr()`, … | `disallowed table function: pg_sleep()` |
| A table not in the source's catalog, including system catalogs and the same table under another schema | `table not in catalog allowlist: public.http_requests` |
| A column the catalog marks `"exposed": false`, by name anywhere (select list, WHERE, ORDER BY, joins) | `column not exposed: http_requests.client_ip` |
| `SELECT *` (or `t.*`, or a whole-row reference) over a table that has an unexposed column | `SELECT * is not allowed on http_requests: it has unexposed columns; name the columns instead` |
| A `:name` the dashboard does not declare | `undeclared variable :host; declare it on the dashboard or remove it` |
| A `$1`-style parameter written into the SQL | `query parameters are reserved by the server` |
| `SELECT … INTO` | `disallowed keyword: into` |
| Row locking: `FOR UPDATE`, `FOR SHARE`, … | `row locking (FOR UPDATE / FOR SHARE) is not allowed` |

A trailing `;` is tolerated and stripped. Everything else PostgreSQL can
express in a read-only SELECT is fine: CTEs (including recursive), joins,
subqueries, `FILTER (WHERE …)`, window functions, `percentile_cont(…) WITHIN
GROUP (ORDER BY …)`, casts, `CASE`, `DISTINCT`, `LIMIT`, set operations, and
TimescaleDB's `time_bucket`.

## What the server does instead, so you must not

- **The time window.** The server wraps the statement and filters the
  dashboard's (or the panel's) window on `query.timeField`:
  `WHERE _holo.<timeField> >= $1 AND _holo.<timeField> < $2`. So:
  - never filter time yourself; a hard-coded `WHERE ts > …` is refused, and a
    fixed interval inside `time_bucket` is fine;
  - `timeField` must be a column the SELECT list OUTPUTS: the bucket's alias
    (`time_bucket('1 minute', ts) AS minute` → `"minute"`), or the raw column
    selected as itself for an unbucketed series (`SELECT ts, service, state …`
    → `"ts"`);
  - order a time series by that column ascending;
  - omit `timeField` when the result has no time column (a scalar, a
    breakdown by a dimension). A panel without one is not windowed at all.
- **Limits.** Rows, result bytes and statement time are capped server-side, and
  the statement runs read-only. Keep results small anyway: bucket, aggregate,
  `LIMIT` a top-N.
- **Row-level filters.** A source can narrow every table to the viewer's rows
  before the statement sees them. Write the query as if the table held only
  what the viewer may see.

## Variables in SQL

- Reference a declared variable as `:name`, unquoted: `WHERE host = :host`.
  Writing `':host'` makes it a string literal that matches nothing.
- For a `multi` variable: `WHERE host = ANY(:host)`.
- Never interpolate a value into the text; the server binds it as a parameter.
- A variable's own `query` has no time filter and references no variable.

## Writing against a catalog

The catalog is the allowlist: the source's `schema` and its `tables`, each with
`columns` (name and type) and, usually, a `timeField` that names its time
column. Use only those tables and exposed columns. Unqualified table names
resolve in the catalog's schema; `schema.table` must be the catalog's schema.
Identifiers are case-sensitive the PostgreSQL way: unquoted names fold to
lowercase, so a table created as `"HttpRequests"` must be written quoted.
