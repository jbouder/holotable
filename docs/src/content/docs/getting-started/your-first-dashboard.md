---
title: Your first dashboard
description: From an empty install to a live dashboard over your own TimescaleDB, in three steps.
sidebar:
  order: 3
---

[Quick start](/getting-started/quick-start/) gets the app running. This page
gets you a dashboard — over **your** database, not the seeded demo. It is the
same three steps the app walks you through on a fresh install, in the same
order, so you can follow either one.

Before you begin you need the app running and signed in, an `AI_PROVIDER` and
`AI_MODEL` configured (see [AI provider](/admin/models/)), and a
**read-only** PostgreSQL or TimescaleDB role that can reach the tables you want
to watch. You also need the `source-admin` role in a workspace for steps 1 and
2, and `editor` for step 3; see the
[Authorization model](/architecture/authorization/).

## The one thing to understand first

The model never sees a single row of your data. It is shown the *catalog* — the
tables and columns you allowed, and nothing else — and it answers with a
validated dashboard spec: what to compute, and how to draw it. The server takes
that spec, guards the SQL, injects the time window, runs it against your
database, and streams the numbers back. On every refresh it runs the SQL again;
it does not ask the model again.

That is why the next two steps exist. The catalog is what the model reads, so
it has to be true before anything it writes can work. See
[How it works](/concepts/how-it-works/).

## 1. Connect a data source

**Data sources → Add source.**

A source is the connection Holotable is allowed to read: host, port, database,
schema, and the list of tables. Fill the form, or describe the database in
plain English and let the drafter fill it for you — either way you review the
values before they are saved.

The one field that is not a connection detail is **secret reference**. It is a
name, like `TS_METRICS`, not a credential, and you pick it from the references
an operator has granted your workspace in `SOURCE_SECRET_REFS`. Holotable
reads `TS_METRICS_USERNAME` and `TS_METRICS_PASSWORD` on the *server* at
execution time. Nothing about your password is stored in the source, in a
dashboard, or in anything sent to the browser.

The operator sets those two values where the server can see them. As files in
`SOURCE_SECRETS_DIR` (a mounted Kubernetes Secret), they take effect without a
restart. In the environment (your `.env`, your container environment), they
need a restart if the server was already running.

The picker shows whether the server currently holds credentials for each
reference. A green check means step 2 will work. A warning names the two
variables to set. If the picker is empty, no reference is granted to this
workspace yet; ask the operator to add one to `SOURCE_SECRET_REFS`.

**This guards against:** a dashboard that carries a password. See
[Source secret references](/admin/secret-references/).

### Or a Prometheus endpoint

Choose the **Prometheus (PromQL)** card under **Kind** to read an existing
Prometheus, Thanos, Mimir or VictoriaMetrics instead. A source's kind is fixed once it is
saved. The form asks for:

- **URL**: the base of the HTTP API, such as `https://prometheus.example.com`.
  It has to be public https unless the operator lists it in
  `SOURCE_URL_ALLOWLIST`, which is where an in-cluster
  `prometheus.monitoring.svc` goes.
- **Authentication**: a bearer token (`<REF>_TOKEN`), a user name and password
  (`<REF>_USERNAME`, `<REF>_PASSWORD`), or none, for an endpoint with no
  authentication. A source with no authentication picks no reference.
- **Metrics**: press **Discover metrics** and search the endpoint's metric
  list, which can run to thousands. Tick the ones the source may read, up to
  200. Picking one asks the endpoint for the labels its series carry. Only the
  ticked metrics may appear in a PromQL panel; a selector naming anything else
  is refused.
- **Tenant label** (optional): a label every ticked metric has, matched against
  a claim of the viewer's, so each viewer sees only their own series. See
  [Row-level filters](/admin/row-level-filters/).

### Or a Loki endpoint

Choose the **Loki (LogQL)** card to read logs from Grafana Loki or Grafana
Cloud Logs. Its panels carry LogQL. The form asks for:

- **URL**: the base the Loki HTTP API answers under, such as
  `https://loki.example.com` (the server adds `/loki/api/v1/…`). The same
  rule as for Prometheus: public https, or listed in `SOURCE_URL_ALLOWLIST`.
- **Authentication**: a bearer token, a user name and password, or none, read
  from the `secret_ref` exactly as for Prometheus.
- **Labels**: press **Discover labels** and search the stream labels the
  endpoint has seen in the last `PROMETHEUS_DISCOVERY_WINDOW` (an hour by
  default; the window is the server's, never the browser's). Tick the ones
  the source may select on, up to 200. Ticking one asks the endpoint for that
  label's values and keeps up to 100 of them as hints for you and the model.
  A real Loki has few labels and many values, so the values are shown beside
  each ticked label. Every stream selector in a LogQL panel must match one of
  the ticked labels exactly (`{app="api"}`); one that does not is refused.
- **Tenant label** (optional): a stream label matched against a claim of the
  viewer's, so each viewer sees only their own streams. See
  [Row-level filters](/admin/row-level-filters/).

### Or files on the server, with DuckDB

Choose the **DuckDB (files)** card to query a directory of Parquet, CSV and
JSON files, or a `.duckdb` database file, that the operator has put under
`DUCKDB_SOURCES_DIR`. The card is there only when the operator has set that
variable and the server's DuckDB binding loaded. A DuckDB source has no credentials, so there is no secret
reference. The form asks for:

- **Path**: pick from the directories and `.duckdb` files directly under
  `DUCKDB_SOURCES_DIR`, or type one below them (`lake/2026`). It is always
  relative: an absolute path, a `..`, or a symlink that leads out of the root
  is refused when you save, and again whenever the source is opened.
- **Tables**: press **Discover tables**. A directory's tables are its
  Parquet, CSV and JSON (`.json`, `.jsonl`, `.ndjson`) files, named by their
  stems (`http_requests.parquet` is
  `http_requests`); a database file's are its own tables. Tick the ones the
  source may read and choose each one's time column, as for a database.

### Or CSV, JSON and Excel files from your computer

Choose the **Upload files** card to make a DuckDB source from CSV, JSON or
Excel files you have, with no access to the server: a bank export, a
spreadsheet (`.xlsx`, each sheet its own table), a streaming history or an
API's saved reply as JSON (an array of objects, one object per line, or one
object). The card is there when the
server can write uploads ([DuckDB files](/admin/duckdb/#uploads)). **Choose
files…**, or try a sample, then **Upload**. The form offers three, which the
app serves under `/samples/`:
**household expenses**
([`household-expenses.csv`](https://github.com/jbouder/holotable/blob/main/public/samples/household-expenses.csv),
six months of made-up household spending), **workouts**
([`workouts.jsonl`](https://github.com/jbouder/holotable/blob/main/public/samples/workouts.jsonl),
a fitness log whose nested `location` becomes one `STRUCT` column, read as
`location.country`) and **home energy**
([`home-energy.xlsx`](https://github.com/jbouder/holotable/blob/main/public/samples/home-energy.xlsx),
a workbook whose `Electricity` and `Gas` sheets become the tables
`home_energy_electricity` and `home_energy_gas`; see
[Workbooks](/concepts/duckdb-sources/#workbooks)). Each file shows its
progress, and the form says what stage it is at: uploading, checking,
discovering tables. Each file becomes a table named after it
(`household-expenses.csv` is `household_expenses`), and the tables are
discovered as soon as the upload is stored. Tick them and create the source
as above. **Cancel upload** stops it, and nothing is kept.

**Success looks like:** a row in the source list.

## 2. Test and refresh the catalog

Two buttons on that row, in this order.

**Test** opens a connection with the resolved credentials and closes it. It
answers one question: can the server actually reach this database as this role?
A failure here is a credential or a network problem, and it is much easier to
read now than as a broken panel later.

**Refresh** introspects the schema and shows what would change: columns added,
removed or retyped, and any allowlisted table the database no longer has.
Nothing is written until you press **Apply**. What it records is the columns
and types of every allowlisted table, and that is what the model is shown.
Refresh does not widen anything — it never adds a table you did not list, it
only makes what you did list accurate. (The one exception is a source made by
uploading files: its refresh offers the files you
[added to it](/concepts/duckdb-sources/#adding-files-to-an-upload-source) as
new tables, for you to review and apply.) A table you allowed that the database no
longer has is reported as missing rather than quietly kept.

**Catalog** opens the source's tables and columns as a searchable tree, with
the catalog's freshness at the top. Untick **Exposed** on any column the model
should not be told about and generated SQL may not read, such as an email
address or an IP. If saved panels already read that column, the browser lists
them and asks before hiding it, because hiding it breaks them. New columns
found by a refresh start exposed.

**This guards against:** SQL written against columns that do not exist. Until a
refresh has run, generating against the source is *refused* rather than
attempted — an unverified catalog is a guess, and the failure would land on you
as a broken chart instead of a sentence.

For a **Prometheus** source, **Test** asks the endpoint for its readiness and a
trivial query, names what answered (Prometheus, Thanos, VictoriaMetrics…),
says whether the credential was accepted, and checks that every allowlisted
metric has series in the last `PROMETHEUS_DISCOVERY_WINDOW` (an hour by
default). In place of the read-only proof, it reads the endpoint's flags: an
admin API or a write receiver that is switched on is reported as a finding,
because the credential should not be able to reach it. The test reads those
flags and never tries a write. **Refresh** re-reads each metric's type and
labels, and reports a metric with no series as missing. **Catalog** lists the
metrics with their type, help and labels; a metric is allowlisted whole, so
there is nothing to hide.

For a **Loki** source, **Test** asks `/ready`, makes one `labels` call with the
credential, names the build that answered (its version is read from
`/loki/api/v1/status/buildinfo`, never probed), and checks that each
allowlisted label has values in the discovery window. A label with none is
listed as a finding. Loki has no write surface a query credential reaches, so
there is no write verdict. **Refresh** re-reads each listed label's values,
shows the values added and gone per label, and reports a label with no
streams as missing; it never adds or drops a label. **Catalog** lists the
labels with their value hints, searchable by name or value.

For a **DuckDB** source, **Test** opens the files as a panel would and
reports the engine's version, whether the path is a directory or a database
file, and whether the engine is **locked**: external access off and its
configuration fixed, so a statement can read this source's files and nothing
else on the server. A lock that does not hold is a finding. It then checks
that each allowlisted table is there. **Refresh** opens the path afresh (for a
directory, a new listing of its files) and re-reads each table's columns.

**Success looks like:** the Catalog column reads *Catalog fresh*, and the row's
table, metric or label count matches what you expect.

## 3. Generate your first dashboard

**Dashboards → New dashboard.**

The source chip at the start of the prompt bar starts on the source you last
generated against (or the first one); open it and tick the sources to use, up
to three from one workspace. Describe what you want to watch in plain English.
Until you send the first prompt, suggestions built from your own catalog (so
they name your tables, not a demo's) sit under the bar, and **Start from a
template…** and your recent prompts sit on the right of the page title; the
model that will answer is the chip beside the source chip. When one of the source's tables reads as
spending, an activity log or daily measurements, its starter dashboard leads,
above the suggestions: **Start from** it and it opens as the first version,
built from your columns with no model call, ready to refine or save (see
[starters for files](/concepts/the-shared-ir/#starters-for-files)). Otherwise,
or for anything else, something concrete works better than something broad:

> Request volume over time and the five slowest routes, plus a stat panel with
> the total error count

Press Enter. While the spec streams in, the space under the prompt bar says
what is being composed, by title and panel count; then the dashboard appears
there and runs its queries against your source. Follow-ups, typed into
the same bar, refine it — "make the third one a bar chart", "add a 95th
percentile line" — and each one is a single model call that returns the whole
dashboard again. **Try again** asks for a different answer to the version you
are looking at instead, and the **Version** menu above the dashboard previews
or restores an earlier one. Nothing is written until you press **Save dashboard**, which
lets you confirm the title first; **Start over**, at the top right, asks and then
discards every unsaved version.

Saving takes you to the live view: the server opens one stream for the whole
dashboard, runs the guarded SQL on the refresh interval, and merges each tick
into the charts. The model is not involved again.

**This guards against:** committing to a dashboard you have not looked at.
Generation, refinement and preview all happen before anything is persisted, so
a first attempt that misreads what you meant costs a follow-up rather than a
saved version you now have to clean up.

**Success looks like:** charts that keep moving, and a green connection dot.

## When it doesn't work

**"No model configured…" where the prompt box would be.** No model is
configured. Set `AI_MODEL` with the matching key on the server, or add one on
the **Models** page. See [AI provider](/admin/models/).

**`credentials for secret_ref "X" are not configured on the server`.** The
source names a secret reference the server has no values for. Set `X_USERNAME`
and `X_PASSWORD` as files in `SOURCE_SECRETS_DIR`, or in the server's
environment and restart it. See
[Source secret references](/admin/secret-references/).

**`secret_ref "X" is not granted to workspace "w"`.** The reference exists, but
not for this workspace. An operator adds the workspace to that reference's
entry in `SOURCE_SECRET_REFS`.

**"The catalog has never been checked against the database."** Step 2 was
skipped. Press Refresh on the source. See
[Generating a panel](/concepts/generating-a-panel/).

**A panel fails with an error naming a table.** The table is not in the
source's allowlist. Refreshing does not add it — the allowlist is the boundary,
and widening it is an edit to the source. Edit the source, add the table, then
Refresh. See
[Source secret references](/admin/secret-references/).

**A query was rejected before it ran.** The SQL guard refused it: it allows one
read-only `SELECT`, over allowlisted relations, with no comments, no
non-deterministic functions, and the server's own time bounds. Ask for the
panel a different way, or look at what the guard objects to in
[Executing a panel](/concepts/executing-a-panel/).

**The source list says a table is missing.** The database no longer has a table
you allowlisted. Edit the source to drop it, or restore it in the database.

## Next

- [Demo data](/operations/demo-data/) — a seeded workspace to compare against.
- [How it works](/concepts/how-it-works/) — the path from prompt to live chart.
- [Invariants](/architecture/invariants/) — the guarantees behind every step above.
