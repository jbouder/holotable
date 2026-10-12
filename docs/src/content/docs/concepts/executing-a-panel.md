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
  `*_to_xml` family that executes a query string, DuckDB's file readers
  (`read_csv`, `read_parquet`, `glob`, …), `query`, `getenv` and extension
  loading — plus server-side sleeps, session state, server identity, advisory
  locks and backend signals. Matched by unqualified name against every call in
  the tree, in any position, so `pg_catalog.pg_sleep(1)` is caught.
- **No table functions in `FROM`**: `FROM generate_series(…)`, `LATERAL
  unnest(…)`, `ROWS FROM (…)` and any other function used as a table is
  refused by name unless it is on an allowlist, which is empty. A table
  function is how DuckDB reads a file, and a denylist only blocks the names it
  has been told about.
- **Forbidden time and non-deterministic values**: `now()` and every synonym,
  `random()`, the parenless keywords (`current_timestamp`, `current_user`, …)
  and the date/time input words (`'now'`, `'today'`, `'yesterday'`) that
  PostgreSQL reads as the clock. The model must not filter or branch on time.
- **Table allowlist**: every relation the tree reads must appear in the selected
  source's catalog — in the top-level `FROM`, a nested CTE, a lateral subquery,
  a set-operation arm, or a `LIMIT` expression alike. CTE names are resolved
  with PostgreSQL's scoping rules first, so `FROM b` after `WITH b AS (…)` is
  the CTE, while a name a later or sibling CTE defines is a real table.
- **Column exposure**: a catalog column marked `"exposed": false` cannot be
  read. A statement that reads a table with such a column is refused if it
  names the column anywhere (select list, `WHERE`, `ORDER BY`, a join
  condition, `USING`), selects `*` or `t.*` directly over the table, references
  the table's whole row (`u`, `row_to_json(u)`, `(u).col`), renames its
  columns with an alias list (`users AS u(a, b)`), or `NATURAL JOIN`s it. The
  rule is name-based across the statement, so it can refuse an exposed column
  of another table that happens to share the hidden column's name; it never
  lets a hidden one through. `*` over a subquery or a CTE is still fine,
  because it expands only to what that body selected. Unexposed columns are
  also left out of the model's prompt, the editor, the starter prompts and the
  built-in templates, and a catalog refresh keeps each column's flag.

The function denylists also run over the raw text after the parse-tree pass, as
a cheap second layer that does not depend on the parser.

If any check fails, the save — or a later tick — reports a clear error instead
of touching the database.

:::caution[This is the whole security boundary]
Statement shape and table access are decided from the parse tree. Which
*functions* may be called is still decided by name against a list, and a list
can only block what it has been told about. `test/sql-safety.fuzz.test.ts`
([#11](https://github.com/jbouder/holotable/issues/11)) generates statements
from adversarial shapes and holds every accepted one to an independent walk of
the parse tree; `npm run test:fuzz` runs it on its own.
:::

## The PromQL guard

A panel against a Prometheus source carries PromQL instead of SQL
([#384](https://github.com/jbouder/holotable/issues/384)), and `validatePromql`
(`src/lib/promql/safety.ts`) is its trust boundary. It parses the expression
with the Prometheus project's own grammar (`@prometheus-io/lezer-promql`,
wrapped in `src/lib/promql/parse.ts`) and walks the tree:

- **Exactly one expression, from allowlisted node types.** A tree with an
  error node is rejected with its position. So are the `@` modifier, comments,
  duration arithmetic, the experimental functions, aggregations and modifiers,
  and anything else the walker has not been told about. A string literal the
  tokenizer would let run unterminated is rejected too.
- **Every selector names one allowlisted metric.** The name may be bare
  (`http_requests_total{…}`), quoted (`{"http_requests_total"}`) or a
  `__name__="…"` equality. It must be on the source's metric allowlist,
  compared exactly. A selector with no name, a `__name__` pattern or negation,
  a name given twice, and `info()` are rejected. Each would read series the
  allowlist does not list.
- **The server owns time.** `@` is rejected in every spelling. A range, a
  subquery range and an `offset` are bounded by `PROMQL_MAX_RANGE` (default
  `7d`). A subquery step is at least a second and evaluates at most 11,000
  points.
- **Bounds.** At most 8,000 characters, 32 selectors and 64 levels of nesting.
- **Variables only as a matcher's whole value.** `{host=":host"}` is the one
  place a `:name` may appear, and it must be declared. A multi-value variable
  needs `=~` or `!~`.

A label the catalog does not list for a metric is a **hint**, not a rejection.
Prometheus answers an unknown label with an empty result rather than an error,
so the author is told without being blocked.

`buildPromqlPlan` (`src/lib/promql/plan.ts`) then writes the variable values in
as escaped literals and splices the viewer's tenant matcher into every selector.
Each rewrite is re-parsed and compared with the original tree. The plan carries
the result with the `start`, `end` and `step` the server chose; the expression
holds no time of its own. `test/promql-safety.test.ts` names every rule and its
message. `test/promql-safety.fuzz.test.ts` generates adversarial expressions and
holds every accepted one to an independent walk of the raw parse tree, and
`npm run test:fuzz` runs it beside the SQL suite.

## The LogQL guard

A panel against a Loki source carries a LogQL expression, untrusted exactly as
SQL and PromQL are. `validateLogql` (`src/lib/logql/safety.ts`, #561) parses it
with the Loki project's own grammar (`@grafana/lezer-logql`, wrapped in
`src/lib/logql/parse.ts`) and walks the tree. LogQL is PromQL with a log
pipeline in front, so the guard is the PromQL guard with the pipeline's rules
added:

- **Exactly one expression, from allowlisted node types.** A tree with an
  error node is rejected with its position, and so are comments. Pipeline
  stages are allowlisted by the grammar node they are: line filters (`|=`,
  `!=`, `|~`, `!~`, `|>`, `!>`, with `ip()`), the parsers (`json`, `logfmt`,
  `pattern`, `regexp`, `unpack`), label filters, `line_format`,
  `label_format`, `keep`, `drop`, `decolorize`, and `unwrap` with its
  conversions. Range functions and aggregations are allowlisted by name. A
  stage or function a newer grammar adds is rejected until it is listed.
- **A log query or a metric query, plainly.** The tree says which: a log
  query returns lines, a metric query (`rate({app="api"}[5m])`) returns
  samples. A log query beside a binary operator is rejected; Loki would
  refuse it too.
- **Every stream selector is anchored on the label allowlist.** It carries at
  least one `=` matcher with a value on a label the source's catalog lists.
  `{app=~".*"}`, `{app!="api"}`, `{app=""}` and a selector anchored only on an
  unlisted label are rejected, as Loki itself would reject the first three.
  Any other matcher on a label the catalog does not list is a **hint**.
- **The server owns time.** The grammar has no `@` and no timestamp. A
  `[range]` and an `offset` are bounded by `LOGQL_MAX_RANGE` (default
  `PROMQL_MAX_RANGE`), a range is longer than zero, and an offset looks back,
  never forward.
- **Bounds.** At most 8,000 characters, 32 stream selectors and 128 levels of
  nesting. A long pipeline is a list, not nesting.
- **Variables only where they are one plain value.** A matcher's whole value
  with `=` or `!=` (`{env=":env"}`, `| level=":level"`) and the string of a
  `|=` or `!=` line filter (`|= ":needle"`). Never in a regex or a pattern
  (`=~`, `!~`, `|~`, `|>`, `regexp`, `pattern`), where a value could change
  the expression's structure, and never as a label name. A multi-value
  variable has no slot.

`buildLogqlPlan` (`src/lib/logql/plan.ts`) writes the variable values in as
escaped literals, checks every selector is still anchored (a bound empty
value is not an anchor), and splices the viewer's tenant matcher into every
stream selector, including those inside range functions and on both sides of
an operator. Each rewrite is re-parsed and compared with the original tree. A
log plan asks for the window's newest lines, `direction=backward`, with a
`limit` of `LOKI_MAX_ENTRIES` (default 1,000, never above `MAX_QUERY_ROWS`, and
the logs panel's own `limit` when it asks for fewer); an answer with that many
lines is badged as cut. A metric plan takes its `step` and alignment from the
PromQL plan's arithmetic, and its result is held to `LOKI_MAX_SERIES`. The Loki
client (`src/lib/loki/client.ts`, #562) sends every one as a GET through the
same guarded exchange as the Prometheus client.
`test/logql-safety.test.ts` names every rule and its message, and
`test/logql-safety.fuzz.test.ts` holds every accepted expression to an
independent walk of the raw parse tree under `npm run test:fuzz`.

## Checking a query before saving

The panel editor does not make an author discover a rejection at save time.

- **Validate** posts the statement to `/api/sql/validate`, which resolves and
  authorizes the source exactly as `/api/query` does and calls the same
  `validateSql`. Nothing is planned and nothing connects to the database, so
  the check is instant — and because it is the same call the save makes, the
  verdict cannot drift from it. A rejection is a `200` carrying
  `{ ok: false, error }`: the request succeeded, and the verdict is the payload.
- **Run preview** posts the panel's `sourceId`, SQL, `timeField` and the
  dashboard's current time range to `/api/query` and renders the rows through
  the same `PanelView` the dashboard uses, with the panel's own viz and format.
  `Ctrl`/`⌘` + `Enter` in the SQL field runs it.
- **What runs** posts the same request to `/api/sql/plan` — see
  [Seeing what actually runs](#seeing-what-actually-runs) below.

None of them touches the dashboard or writes a version, and none is a way
around the guard: the preview is an ordinary guarded execution, and the save
re-validates every panel regardless of what was checked here.

## Writing the query — the catalog-aware editor

The SQL field is a CodeMirror editor (`src/components/sql/SqlEditor.tsx`),
loaded on demand so that nothing in a dashboard *viewer's* bundle carries an
editor. Until the chunk arrives — or if it never does — the same field renders
as a plain textarea with the same value, so the editor is an improvement on the
control, never a prerequisite for it.

What it knows comes from the selected source's catalog, projected for the
browser by `sourceCatalog` (`src/lib/registry.ts`): the schema name, the
allowlisted tables and their exposed columns, and nothing that says how to reach the
database. The host, port, database, TLS setting and `secret_ref` stay on the
server.

- **Completion** offers exactly the allowlisted tables and their columns, with
  each column's type as the detail line. What completes is what the guard
  accepts, so taking a suggestion cannot produce a catalog rejection. It
  reconfigures in place when the panel's source changes.
- **Hints** underline the guard's most common refusals while typing —
  a comment, a second statement, a table outside the allowlist, `now()`,
  `current_timestamp`, `'today'`. They come from a lexical scan
  (`src/lib/sql/hints.ts`), *not* a second copy of the guard, and the two are
  asymmetric on purpose: a hint is only raised when a scan can be certain the
  server will refuse. Anything less certain stays silent, because underlining
  a valid query teaches authors to ignore the underlines. A statement with no
  hints has not been accepted — it has only not been convicted; `Validate`
  above is the answer.
- **`timeField`** is a picker rather than free text. It offers the query's own
  output columns first (read off the SELECT list) and the catalog's timestamp
  columns after — which *are* the output columns when the query selects `*` —
  and warns when the declared field is not among the outputs. That is the
  missing-`timeField` error at the bottom of this page, said before the query
  runs instead of after. Free text stays available for the cases the scan
  cannot name.

`Ctrl`/`⌘` + `Enter` runs the preview from the editor. `Escape` moves focus to
the editor's wrapper so `Tab` continues into the rest of the form; `Tab` itself
is left alone rather than bound to indentation, so the editor is never a
keyboard trap.

### A PromQL panel

A panel on a Prometheus source gets a PromQL editor in the same place
(`src/components/promql/PromqlEditor.tsx`), built the same way: loaded on
demand, a textarea until then, the same keys. Its catalog is the source's
metric allowlist and each metric's labels, from the kind's own projection; the
endpoint's URL and credential never reach the browser.

- **Completion** offers the allowlisted metrics (with their type and help) and
  the functions the guard allows where an expression can start, and a metric's
  labels inside its selector's braces (`src/lib/promql/completion.ts`).
- **Hints** are the guard's own. A pause in typing posts the expression to
  `/api/sql/validate`, and the answer is drawn in place: a refusal as an error,
  and the guard's hints as warnings on the name they mention. The hints are a
  label the allowlist does not list, `rate()` over a gauge, and a counter
  drawn without `rate()` or `increase()`. A hint never refuses.
- **Instant** and **Min step** stand where the time-field picker does. There
  is no time field: a range query's rows are always keyed by `time`, an
  instant query has none, and the server picks the step. Min step only raises
  it.

Changing a panel's source to one of the other kind does not carry the query
across, because its language is wrong there. The panel starts over from the
new source's starter for its kind (`src/lib/panel-starter.ts`): a counter's
rate, as a range for a line and an instant for a stat. Undo brings the old one
back.

### A LogQL panel

A panel on a Loki source gets a LogQL editor
(`src/components/logql/LogqlEditor.tsx`, #565), built like the PromQL one:
loaded on demand, a textarea until then, the same keys. It highlights with
the grammar the guard parses with (`@grafana/lezer-logql`), and its catalog is
the source's label allowlist with the values discovery found for each.

- **Completion** offers the listed labels inside a stream selector's braces,
  in a `by (…)` and after a `|`; a listed label's values inside a matcher's
  quotes, escaped for the string (and for the regex, after `=~`); the
  pipeline stages after a `|`; and the range functions and aggregations the
  guard allows where an expression can start (`src/lib/logql/completion.ts`).
  `test/logql-completion.test.ts` holds every function and stage it offers to
  the guard.
- **Hints** are the guard's own, as for PromQL: a refusal as an error where
  it points, and a label the allowlist does not list as a warning on it.
- **Instant** and **Min step** are for a metric query. A log query has no
  say in how it runs: the server picks the range, the `limit` (the panel's
  own when it asks for fewer lines) and the `direction`, and the guard
  refuses an instant log query.

A new panel on a Loki source starts from the first listed label at its first
known value, `{job="api"}`, as lines for a logs panel and as
`sum(count_over_time({job="api"} [5m]))` for a chart.

One operational detail: the page's Content-Security-Policy has no
`'unsafe-inline'` for styles, and CodeMirror builds its stylesheet at runtime.
The editor reads this document's nonce back out of the DOM
(`src/lib/csp-nonce.ts`) and hands it to `EditorView.cspNonce`; without it the
browser drops the stylesheet and the editor renders as unstyled text.

## The server owns time

Real data enters the system only here — server-side, from a stored spec. Three
places share the same guard code: the live poller, the one-shot query route, and
the read-only dashboard chat's `runQuery` tool. The core is
`buildExecutablePlan`, which runs **after** `validateSql` has passed.

The validated query is wrapped as a subquery, and the dashboard's resolved
`from`/`to` are injected as **bound parameters** on the declared `timeField`:

```sql
SELECT * FROM (
  SELECT _holo.*, row_number() OVER () AS _holo_pos, count(*) OVER () AS _holo_total
  FROM (<the model's validated SQL>) AS _holo
  WHERE _holo.<timeField> >= $1::timestamptz
    AND _holo.<timeField> <  $2::timestamptz
  ORDER BY _holo.<timeField> DESC, _holo_pos DESC
  LIMIT <maxQueryRows>        -- default 5000
) AS _holo_kept
ORDER BY _holo_kept._holo_pos
```

- `from`/`to` come from `resolveTimeRange` (`src/lib/time.ts`), which turns the
  IR's relative expressions (`now-1h`) into concrete dates. The model never
  supplies a time value; it only named the column.
- A source with a row filter adds one more bound parameter, the viewer's
  claim value, spliced in where each table is read rather than on this wrapper
  ([Row-level filters](/admin/row-level-filters/)). Dashboard variables
  bind after it, one `$n` per declared name
  ([Dashboard variables](/guide/variables/)). Without a `timeField` the
  wrapper has no `WHERE`, and the numbering starts at `$1`.
- `timeField` is re-checked against a strict identifier regex before
  interpolation — it is an identifier, so it cannot be a bound parameter.
- A hard `LIMIT` caps rows regardless of what the query does. With a
  `timeField` it keeps the **newest** rows (#486): the cut is newest-first on
  the time field, and the survivors go back into the statement's own order by
  their position in it, so a series keeps its live edge and a newest-first log
  stays newest-first. `_holo_total` is how many rows the window held; the
  executor strips both bookkeeping columns and reports the cut as the
  result's `truncated`, which the panel shows as a badge. Without a
  `timeField` the wrapper is `SELECT * FROM (…) AS _holo LIMIT <maxQueryRows + 1>`:
  the first rows, with one extra asked for so a cut is seen rather than
  guessed.
- The wrapper is re-parsed after it is built, and refused unless its `_holo`
  subquery is exactly the checked statement under the expected `LIMIT`
  (`verifyWrapper` in `src/lib/sql/safety.ts`).
- `MAX_RESULT_BYTES` (default 4 MiB) caps the serialized size of the result:
  `executePlan` measures rows as they stream in from Postgres and stops
  keeping them the moment the cap is crossed, so a wide-row result fails with
  an actionable message naming the limit instead of being buffered whole.

## PostgreSQL without TimescaleDB

The TimescaleDB kind runs against plain PostgreSQL too: Neon, Supabase, RDS,
Aurora, or a `postgres:16` of your own. The driver, the guard, the server's
time window, the limits and read-only execution above are the same, because
none of them uses the extension.

What differs is bucketing. `time_bucket` is TimescaleDB's, and on plain
PostgreSQL it does not exist; the equivalents are `date_trunc('minute', ts)`
for a calendar unit and `date_bin('5 minutes', ts, TIMESTAMP '2000-01-01')`
for a fixed interval. Both pass the guard (a constant origin is not a time
word), and the starters and built-in templates already use `date_trunc`, so
they work on either.

There is nothing to set. **Test** and **Refresh** read `pg_extension` and
record what they found on the source (`catalog_facts`, see the
[data model](/architecture/data-model/)). The data sources page and the
catalog browser then say **PostgreSQL** or **TimescaleDB 2.17.2**. When the
extension is missing, the generation prompt's catalog block ends with one
fixed paragraph telling the model that `time_bucket` does not exist and what
to use instead, so the first answer works rather than the repair loop
learning it from an error. The paragraph is constant text: the version
string is shown to people, never sent to the model. A source that has not
been tested since this was added is prompted as before, until its next Test
or Refresh.

## Read-only execution

`executePlan` (`src/lib/timescaledb/client.ts`) runs the plan in a **read-only
transaction** as the source's read-only role, with a statement timeout
(`QUERY_TIMEOUT_SECONDS`, default 20s). Inside the transaction it first pins
`SET LOCAL search_path` to the source's configured schema — validated as a bare
identifier — plus `public`, so the catalog's bare table names resolve only
against the allowlisted schema. Credentials are resolved from the environment
via the source's `secret_ref`; they are never stored in the spec and never leave
the server.

The connection comes from the source's pool (`src/lib/timescaledb/pool.ts`), at
most `MAX_POOL_PER_SOURCE` connections per source (default 5). The
`secret_ref` grant is still checked on every execution. Changing the source's
host, database, TLS settings or credentials replaces the pool. The transaction
is always rolled back before the connection goes back, which also undoes the
`SET LOCAL`. A connection whose statement failed for any reason other than a
SQL error, or whose rollback failed, is closed instead of reused.

Net effect: the model controls *what to compute*, but not the time window, not
resource usage, and not which credentials or tables it can touch.

## Seeing what actually runs

Everything above happens to a statement after its author has stopped looking at
it. `POST /api/sql/plan` shows the result, for one panel, without running it:

- the wrapped statement as the server would send it, `LIMIT` and all;
- the bound parameters, with the relative expression each was resolved from
  (`$1 = 2026-09-22T11:00:00Z`, resolved from `now-1h`) and labeled as
  server-supplied;
- the row, time and byte limits in force;
- the session statements the query runs inside — the read-only transaction and
  the pinned `search_path`.

It is the same route as `/api/query` with the execution removed: the same
`validateSql`, `resolveTimeRange`, `buildExecutablePlan` and
`sessionStatements`. Re-deriving any of them for display would let the
explanation drift from the behavior it explains, which is the whole point of
showing it. Nothing connects to the source's database and nothing is written.

A statement the guard refuses is a `400` with the guard's own message. Unlike
`/api/sql/validate` there is no `{ok:false}` verdict to return, because a
refused statement has no plan.

Authorization is `/api/sql/validate`'s — `dashboard:generate` on the source's
workspace — for the same reason: the request body carries arbitrary SQL and a
rejection names the table or function the guard refused, so answering is the
same catalog disclosure that previewing a query is.

The response shape is an explicit allowlist (`src/lib/query-plan.ts`), like
`panelDetails()`: a source is named by its opaque id, and no host, database,
user or `secret_ref` has a field to travel in.

It is reachable from the panel editor (**What runs**) and from the viewer's
query dialog (**Show query** in the panel's menu), which is where a reader who
did not write the panel can check that the window really is the server's.

For a PromQL panel the same route answers with the PromQL plan:

- the expression the endpoint receives, with the viewer's tenant matcher
  spliced in and each variable's value already bound, so both are visible as
  the row-filter subquery is for SQL;
- `/api/v1/query` with `time`, or `/api/v1/query_range` with `start`, `end` and
  `step`, each with what the server resolved it from: `now-1h`, aligned to the
  step, and for the step "the window ÷ 1,000 points, floored at 15 s", plus
  the panel's Min step when it has one;
- each variable the expression references and the value bound for it;
- the limits, as "1,000 points · 20 s · 4.0 MiB · 100 series".

The endpoint's URL and auth mode have no field in the view.

A LogQL panel's plan has the same layout: the expression sent to
`/loki/api/v1/query_range` (or `/loki/api/v1/query` for an instant metric
query) with the tenant matcher and the variables in it; `start` and `end`,
and for a log query `limit` (from `LOKI_MAX_ENTRIES`, or the panel's own
limit when it asks for fewer) and `direction` (`backward`, so the limit keeps
the newest lines), or for a metric query `step`, worked out as PromQL's is;
the tenant matcher's claim; each bound variable; and the limits, as
"1,000 lines · 20 s · 4.0 MiB" for a log query.

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

## What the editor holds before a save

The editor (`src/app/dashboards/[id]/edit/`) is the one writer of a spec,
beside a rename and a restore from the history, and nothing it holds reaches
the server until Save. The model and the client can propose anything; nothing
they propose is trusted until the save re-derives it. Four things make that
session usable ([Editing a dashboard](/guide/editing-a-dashboard/)) without
weakening it:

- **Previews run through `/api/query`.** Each panel's guarded query runs once,
  and again only when that panel's SQL, window or variable values change, after
  a short pause in typing (`src/lib/preview-runs.ts`). Moving, resizing or
  restyling reuses the rows the panel has, and the chart is never recreated.
- **The starter is guaranteed to run.** A new panel starts from a query built
  out of the selected source's catalog (`src/lib/panel-starter.ts`): the first
  allowlisted table with a time column, counted per minute, as a line; a plain
  `count(*)` as a stat when no table has a time column; `SELECT 1 AS value`
  when nothing is usable. Every name comes from the allowlist, so it passes the
  guard against that source, and it never filters time itself, because the
  server owns the range. A Prometheus source starts from PromQL the same way —
  a counter's `sum(rate(…[5m]))`, else a histogram's p95, else a gauge's sum,
  else a count of any listed metric's series, else `vector(1)`; a range query
  for a line and an instant query for a stat, gauge, table or pie — and its
  built-in templates are golden signals built from its counters, histograms
  and gauges (`src/lib/builtin-templates-promql.ts`).
- **History is a bounded stack** (`src/lib/editor/use-history.ts`). Every
  change to the spec is one entry, a burst of keystrokes in one field within a
  second coalesces into one, and the editor's binding is suppressed while
  focus is in a field so the browser's own undo still works there.
- **Drafts never reach the server** (`src/lib/editor/drafts.ts`). The working
  spec is mirrored to `localStorage`, keyed by dashboard and signed-in
  subject, and offered back by a click, never restored on load. A draft is an
  unvalidated spec only its author has seen; the only thing the system writes
  is an explicit saved version, re-validated and re-guarded. A server-side
  draft table is an explicitly optional extension in
  [#118](https://github.com/jbouder/holotable/issues/118) and is not built.
  Drafts are per user, capped in size, expire after a week, and expired ones
  from every dashboard are pruned whenever the editor opens.
