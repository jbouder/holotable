---
title: DuckDB sources
description: A directory of Parquet, CSV and JSON files, or a .duckdb file, as a data source. Its panels are the same guarded SQL, run in process against a locked engine.
---

A source has a **kind** ([Source kinds](/architecture/data-model/#source-kinds)).
A **DuckDB** source reads files that live on the server: a directory of
Parquet, CSV and JSON files, or a `.duckdb` database file, under a root the operator
chooses. It is the second SQL kind. Its panels carry the same `query.sql` a
TimescaleDB panel does, checked by the same guard and windowed by the same
plan. What differs is where the rows come from: DuckDB runs inside the server
process, so there is no connection, no credential and no network. Everything
else the app guarantees still holds. The model writes a spec and never data,
the query is untrusted, the server owns the window, and a spec names its
source by an opaque id.

## The source

A DuckDB source's config is a path and the same table allowlist a database
source has:

```json
{
  "kind": "duckdb",
  "path": "lake/requests",
  "tables": [
    {
      "name": "http_requests",
      "timeField": "ts",
      "columns": [
        { "name": "ts", "type": "TIMESTAMP" },
        { "name": "route", "type": "VARCHAR" },
        { "name": "status", "type": "SMALLINT" },
        { "name": "duration_ms", "type": "DOUBLE" }
      ]
    }
  ],
  "rowFilter": { "column": "tenant", "claim": "tenant" }
}
```

- **`path`** is relative to `DUCKDB_SOURCES_DIR`, the root the operator sets
  ([DuckDB files](/admin/duckdb/)). It never starts with `/`, never contains
  `..`, an empty or `.` segment, or a backslash, and is at most 512
  characters. Unset, `DUCKDB_SOURCES_DIR` refuses every DuckDB source, so the
  kind is closed until an operator decides what it may read.
- **`tables`** is the allowlist, exactly as for a TimescaleDB source: a table,
  its columns (with per-column exposure) and an optional `timeField`. A query
  may read only what it lists.
- **`rowFilter`** is optional and works as it does on a database source: see
  [row-level filters](/admin/row-level-filters/).

A DuckDB source names no `secret_ref`, and saving one with a ref is refused.
Its path is in the stored config, which only a source admin sees. A listing
shows whether it is a directory or a database and how many tables it has,
never the path. The path is kept out of results, Test reports, plan views,
error messages and log lines too.

The **Data sources** page registers one through the **DuckDB (files)** card.
**Path** offers the directories and `.duckdb` files directly under the root
(`GET /api/sources/duckdb/paths`, names only), and **Discover tables** opens
the path as a panel would and fills the allowlist. See [your first
dashboard](/getting-started/your-first-dashboard/#or-files-on-the-server-with-duckdb).

## Uploaded files

A source admin with no access to the server can make a DuckDB source from CSV
or JSON files instead: the **Upload files** card. The files are sent to
`POST /api/sources/duckdb/uploads`, which streams them to
`DUCKDB_SOURCES_DIR/uploads/<workspace id>/<fresh id>/<name>.<ext>` and answers
the relative directory, and the form goes on as above, from **Discover
tables**. Nothing new reaches the IR, a listing or the browser: an uploaded
source is a directory source whose directory the server wrote, and `path` is
an ordinary relative path. Each file's table is its stem reduced to
`[a-z0-9_]`, so `Household Expenses.csv` is `household_expenses`. A file keeps
its extension when it is `.json`, `.jsonl` or `.ndjson`, so the directory
reads it as [JSON](#json-files); a file with any other name is stored as
`.csv` and read as CSV. Two samples to try ship with the app, and the form
offers both:
[`household-expenses.csv`](https://github.com/jbouder/holotable/blob/main/public/samples/household-expenses.csv)
(`date, merchant, category, amount, payment_method`; DuckDB reads `date` as
`DATE` and `amount` as `DOUBLE`) and
[`workouts.jsonl`](https://github.com/jbouder/holotable/blob/main/public/samples/workouts.jsonl)
(a fitness log, one object per line, whose nested `location` is the column
`location STRUCT(city VARCHAR, country VARCHAR)`).

An upload is all or nothing, and bounded: a file over
`DUCKDB_UPLOAD_MAX_BYTES`, too many files, a file that is not UTF-8 text, an
empty file or two files that would be one table (`events.csv` and
`events.jsonl` included) refuse the whole upload, and nothing is kept. A JSON
file is held to the same caps and the same text check as a CSV. The operator's side, and how to turn uploads on, is in
[DuckDB files](/admin/duckdb/#uploads).

## The path and the root

A path is checked twice. When it is typed, lexically, by the rules above.
Then on save, and again on **every** open, by the path guard
(`src/lib/duckdb/path.ts`), which:

1. resolves `DUCKDB_SOURCES_DIR` and the joined path through `realpath`, so a
   symlink is judged by where it lands;
2. refuses anything that lands outside the root;
3. checks the target is a directory, or a regular file whose name ends
   `.duckdb`.

It also holds [uploads](#uploaded-files) to their workspace: a path under
`uploads/` must be `uploads/<the source's own workspace>/<upload>`, as typed
and where it resolves, so a source cannot name, or symlink its way into,
another workspace's files.

Its refusals name the variable, never a path. Because the guard runs on every
open, a symlink changed after a source was saved cannot point an existing
source somewhere new, and a stored row naming another workspace's uploads
cannot run.

## Two layouts

| `path` names | What the tables are |
| --- | --- |
| A **directory** | One view per `.parquet`, `.csv`, `.json`, `.jsonl` or `.ndjson` file directly under it, named by its stem: `http_requests.parquet` is the table `http_requests`. Not recursive. Other extensions, and anything a symlink takes outside the directory, are skipped. When two files share a stem, one view is made, from Parquet first, then CSV, then JSON (`a.parquet` over `a.csv` over `a.json`; between two JSON files, the first by name). At most 200 files, in name order. |
| A **`.duckdb` file** | The database's own tables in `main`. It is attached `READ_ONLY`. |

A directory is the shape a data-lake drop, a vendor export or a batch job's
output usually has. A new file becomes a table on the next **Refresh**, never
by itself: the catalog is what the last refresh found
([out of scope](/admin/duckdb/#what-is-out-of-scope): hot reload). Replacing a
file's contents under the same name needs no refresh. The next query reads the
new file, which is how the [files demo](/operations/demo-data/#the-files-demo)
moves its live edge forward every minute.

## JSON files

A `.json`, `.jsonl` or `.ndjson` file is read by DuckDB's bundled JSON reader,
`read_json_auto`, which takes an array of objects, one object per line, or a
single object (one row). The `json` extension is compiled into the binding, so
nothing is installed or loaded and the lock is the same as for any other file.
Each top-level key is a column; a nested object is a `STRUCT` column and an
array a list, shown in the catalog by DuckDB's own type name
(`STRUCT(city VARCHAR, country VARCHAR)`, `VARCHAR[]`). Nothing is flattened:
a query reads a field as `location.city` or `location->>'city'`, and the model
is told so.

The reader samples a file to type it and is bounded explicitly, by constants
beside the engine's other caps in `src/lib/duckdb/client.ts`: one object (an
array element, a line) may be at most 16 MiB (`JSON_MAX_OBJECT_BYTES`, the
reader's `maximum_object_size`), and the columns and types are inferred from
the first 20,480 records (`JSON_SAMPLE_ROWS`, `sample_size`). The memory
limit, the thread cap and the query timeout stay the outer bound. A file the
reader cannot parse fails **Discover tables**, **Refresh** and every query
with a message that names its table (`the file for the table "events" could
not be read: …`), never its path.

## The catalog

**Discover tables** and **Refresh** open a fresh, locked engine and read
`information_schema.columns` in `main`. For a directory, that means listing
the files again. Column types are DuckDB's own names (`TIMESTAMP`, `VARCHAR`,
`DOUBLE`, `BIGINT`). The time column picker offers `TIMESTAMP`,
`TIMESTAMP_NS`/`_MS`/`_S`, `TIMESTAMPTZ`, `DATE` and `TIME` columns. As on
every kind, a refresh never adds a table to the allowlist and never drops one:
a file that has gone is reported as a missing table, with its last known
columns kept. **Test** probes each allowlisted table with `LIMIT 0` and reports
the engine version (`DuckDB 1.5.6`), the layout and whether the lock holds.

## The dialect

DuckDB's parser descends from PostgreSQL's, so the grammar the guard already
parses is DuckDB's grammar too, and a statement reads the same on both kinds.
What the model is told for a DuckDB source (`DUCKDB_PROMPT` in
`src/lib/duckdb/catalog.ts`):

- **Bucketing time.** `time_bucket(INTERVAL '5 minutes', ts)`,
  `date_trunc('minute', ts)` and `date_bin(INTERVAL '5 minutes', ts,
  TIMESTAMP '2000-01-01')` all exist.
- **Column names are case-sensitive as listed.** A name that is not all
  lowercase is double-quoted (`"Value"`).
- **No `::timestamptz`.** The time column is used as it is.
- **Nested JSON.** A `STRUCT` column is read with `struct.field`
  (`location.city`) or `->>` (`location->>'city'`).
- **No table functions.** Query the listed tables, not `read_parquet(…)`,
  `read_csv(…)` or `read_json(…)`.

```sql
SELECT time_bucket(INTERVAL '1 minute', ts) AS minute,
       count(*) FILTER (WHERE status >= 500) AS errors
  FROM http_requests
 GROUP BY minute
 ORDER BY minute
```

The window is bound the same way as on TimescaleDB, as parameters on
`timeField` in a wrapper the server adds. The kind supplies the cast:
`TIMESTAMP` rather than `timestamptz`. The engine's `TimeZone` is fixed to UTC
and locked, so a `TIMESTAMP` column is read as UTC, and a `TIMESTAMPTZ`
column compares against the same instants.

## What the guard adds

Every DuckDB query passes `validateSql` unchanged, the same SELECT-only,
allowlisted, bounded walk a TimescaleDB query takes
([The SQL guard](/concepts/executing-a-panel/#the-sql-guard)). Two of its
rules exist mostly for DuckDB:

- **DuckDB's file and engine functions are denied**: the readers
  (`read_csv`, `read_parquet`, `read_json`, `read_text`, `glob`, …), the
  functions that execute a query string (`query`, `query_table`), the
  environment and settings (`getenv`, `current_setting`, `duckdb_settings`,
  `duckdb_secrets`, …), catalog introspection beyond the allowlist
  (`duckdb_tables`, `duckdb_columns`, …) and DuckDB's clock and random
  readings. The fuzz suite holds them.
- **No table function in `FROM`.** A table function is how DuckDB reads a
  file, so `FROM read_parquet('/etc/…')`, and any function used as a table
  that a denylist might not name yet, is refused by its node type.

`COPY`, `ATTACH`, `INSTALL`, `LOAD`, `SET`, `PRAGMA` and `CREATE` are not
a `SELECT`, so the guard refuses them as it refuses any other statement.

## What the server owns

The guard is the first belt. The engine is the second. Each source gets one
in-process engine, which is locked before any statement a panel wrote can run
([DuckDB](/architecture/data-model/#duckdb) in the data model):

| The engine is set to | So a statement the guard missed still cannot |
| --- | --- |
| `allowed_paths` = the source's own files, then `enable_external_access=false` | read any other file, a sibling directory or `/etc`, create a file, or reach the network |
| `autoinstall_known_extensions=false`, `autoload_known_extensions=false` | install or load an extension, such as `httpfs` |
| a `.duckdb` file opened `READ_ONLY` | write to the database |
| `memory_limit` (`DUCKDB_MEMORY_LIMIT`), `threads` (`DUCKDB_THREADS`) | take more memory or cores than the operator allowed |
| `TimeZone='UTC'` (`SET GLOBAL`, before the lock) | read time in the server's local zone |
| `lock_configuration=true` | change any of the above with `SET` |

Each is tested against the real engine with the guard bypassed. On top of
that, a query is interrupted at `QUERY_TIMEOUT_SECONDS`, rows stream through
the same row and byte caps every SQL source has, and every cut travels as
`truncated` to a badge on the panel. The plan dialog (**Show query**) shows
the lock statements as they run, with the files named by their role.

One gap remains, by design of DuckDB 1.5: the engine may write wherever it may
read, so a statement could overwrite one of the source's own listed files.
The guard, which allows exactly one `SELECT`, is what stops that, and
[mounting the root read-only](/admin/duckdb/#the-mount) is the belt
behind it.

## What is refused, and why

| Refused | Because |
| --- | --- |
| A path that is absolute, has `..`, or resolves outside `DUCKDB_SOURCES_DIR` | A path is as untrusted as a URL. The root is the operator's decision. |
| A path under `uploads/` that is not an upload of the source's own workspace | Uploaded files are their workspace's; the guard checks it on save and on every open. |
| Any DuckDB source while `DUCKDB_SOURCES_DIR` is unset | Closed by default: nothing is readable until the operator names a root. |
| A table not on the allowlist | The allowlist is the catalog, exactly as for a database. |
| `read_csv(…)`, `FROM read_parquet(…)`, `read_json(…)`, `glob(…)` and every other file function | A file function reads whatever path it is given, past the allowlist and the root. |
| `ATTACH`, `INSTALL`, `LOAD`, `SET`, `COPY` | Not a `SELECT`; and the locked engine would refuse each of them anyway. |
| `s3://`, `https://`, `httpfs` | A file is local to the server. Remote storage is an operator's mount, not Holotable's fetch. |
| Every run, with "DuckDB is not available on this server" | The platform has no DuckDB binding. Every other kind keeps working. |
