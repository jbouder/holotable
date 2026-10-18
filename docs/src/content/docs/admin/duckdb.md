---
title: DuckDB files
description: Letting DuckDB sources read files on the server — the root, uploads from the browser, the lock and allowed paths, the mount, the memory and thread bounds, and the binding.
---

What a DuckDB source is, and how its SQL runs, is in
[DuckDB sources](/concepts/duckdb-sources/). This page covers what an operator
sets up so source admins can register one.

## The root: `DUCKDB_SOURCES_DIR`

DuckDB sources are **off** until you name the one directory they may read:

```bash
DUCKDB_SOURCES_DIR=/var/lib/holotable/files
```

It must be an absolute path (startup validation refuses anything else). Every
source's `path` is relative to it, and the path guard resolves both through
`realpath` and refuses anything that lands outside it, symlinks included, on
save and again on every open. Unset, the **DuckDB (files)** card is hidden,
and saving, testing or running a DuckDB source fails with "DuckDB sources are
off on this server: set DUCKDB_SOURCES_DIR to the directory they may read."
Setting `DUCKDB_MEMORY_LIMIT` or `DUCKDB_THREADS` without it is a startup
warning, since they would bound nothing.

Lay it out as one directory (or one `.duckdb` file) per source, directly under
the root. Those are what the path picker offers. A directory's tables are its
`.parquet`, `.csv`, `.json`, `.jsonl` and `.ndjson` files; when two share a
stem, Parquet wins over CSV and CSV over JSON
([Two layouts](/concepts/duckdb-sources/#two-layouts)):

```
/var/lib/holotable/files/
├── requests/                 a source: one table per file
│   ├── http_requests.parquet
│   ├── hosts.csv
│   └── deploys.jsonl
├── finance/
│   └── daily_revenue.parquet
└── warehouse.duckdb          a source: the database's tables
```

The root is one list for every workspace. A source admin in any workspace may
register any path under it, so a directory that must stay one tenant's
belongs under a root of its own, on a server of its own, or behind a
[row-level filter](/admin/row-level-filters/). The one exception is
`uploads/`, below: it is never offered in the picker, and each workspace may
name only its own.

## Uploads

A source admin can also make a DuckDB source from CSV, JSON or Excel files
uploaded in the browser ([#595](https://github.com/jbouder/holotable/issues/595),
[#596](https://github.com/jbouder/holotable/issues/596),
[#597](https://github.com/jbouder/holotable/issues/597)), with no
access to the server: **Add source → Upload files**. The files land under the
same root, never a second one:

```
/var/lib/holotable/files/
└── uploads/
    └── <workspace id>/
        └── 3f9c0a51d2e47b86/          one upload: a fresh random id
            ├── household_expenses.csv
            ├── budget_2026.csv
            ├── workouts.jsonl
            ├── home_energy_electricity.csv   from home-energy.xlsx
            └── home_energy_gas.csv           (the workbook is not kept)
```

Each file is named by its own stem, lowercased and reduced to `[a-z0-9_]`
(`Budget 2026.csv` is `budget_2026`; a stem that starts with a digit gets
`t_` in front), because that is the table's name. A `.json`, `.jsonl` or
`.ndjson` file keeps its extension (lowercased), because the directory picks
a file's reader by it; a file with any other name is stored as `.csv`. An
`.xlsx` or `.xlsm` workbook is converted to a CSV per sheet as it arrives
([Workbooks](#workbooks)). Files can be chosen or dropped on the form. The form offers three samples the app serves,
[`household-expenses.csv`](https://github.com/jbouder/holotable/blob/main/public/samples/household-expenses.csv),
[`workouts.jsonl`](https://github.com/jbouder/holotable/blob/main/public/samples/workouts.jsonl)
and
[`home-energy.xlsx`](https://github.com/jbouder/holotable/blob/main/public/samples/home-energy.xlsx). The source stores the
directory, `uploads/<workspace id>/<id>`, like any other path, and is a
directory source from then on: Test, Refresh and every query go through the
same guard and the same locked engine.

**On and off.** Uploads are on when `DUCKDB_SOURCES_DIR` is set, the binding
loads, and the server can create and write `<root>/uploads`. Otherwise the
**Upload files** card is hidden and the upload route answers why, naming the
variable and never the path. The server needs write access to `uploads/`
only; [the rest of the root](#the-mount) can stay read-only.

**The rules.** An upload is all or nothing. Each of these refuses the whole
request, and a refused or cancelled upload leaves no file behind:

| Refused | Bound |
| --- | --- |
| A file larger than `DUCKDB_UPLOAD_MAX_BYTES` | default `52428800` (50 MiB) |
| More than `DUCKDB_UPLOAD_MAX_FILES` files | default `20`, at most `200` (a source's table limit) |
| A file that is not text: a NUL byte, or not UTF-8, in its first 64 KiB | whatever its name or content type says; CSV and JSON alike (not a workbook, which is binary) |
| An empty file, a name that reduces to nothing, two files that would be one table (`events.csv` and `events.jsonl` too) | |
| A workbook's CSVs, together, larger than `DUCKDB_UPLOAD_MAX_BYTES` | the same bound as the workbook itself |
| A workbook with more sheets to convert, or a sheet with more rows | 32 sheets, 1,000,000 rows (`MAX_WORKBOOK_SHEETS`, `MAX_SHEET_ROWS` in `src/lib/duckdb/uploads.ts`) |
| `.xls`, `.xlsb`, `.ods`, `.numbers` | refused by name: only `.xlsx` and `.xlsm` are converted |

The file is streamed to disk as it arrives and never held whole in memory.
A malformed bound is a warning in development (the default is used) and a
startup error in production; set without `DUCKDB_SOURCES_DIR`, it is a
warning, since no upload can land.

### Workbooks

An `.xlsx` workbook, or an `.xlsm` one
([#604](https://github.com/jbouder/holotable/issues/604)), which is the same
container with macros beside the sheets, is streamed to a temporary file inside the upload's own
directory, converted there to one `<table>.csv` per visible sheet with data,
and removed, so the directory holds only CSVs and the engine is exactly as
it is for any other upload: no `excel` extension, nothing loaded before the
lock. The naming and cell rules are in
[DuckDB sources](/concepts/duckdb-sources/#workbooks); dates are written as
the sheet shows them and read as UTC, the engine's zone.

The workbook is untrusted. It is read with a small ZIP reader over Node's
own zlib and the `saxes` XML parser (pure JavaScript, no native code), which
expands no entity the XML did not start with. Every part is inflated as a
stream against a cap counted as it comes out (1 GiB for a sheet, read twice:
once to count, once to write; 128 MiB for the shared text and styles, which
are held), so an archive that claims to be small and inflates without end
stops at the cap. An encrypted entry, a ZIP64 archive and anything that is
not an Office Open XML workbook are refused. Every refusal names the file
and the sheet, never a path. Only the sheets' XML is read: an `.xlsm`
workbook's macros are never opened, let alone run, and are not kept.

### Adding files

An upload source can take more files later
([#604](https://github.com/jbouder/holotable/issues/604)): **Add files** on
its row in **Data sources** (shown only for a source made by uploading, and
only to a source admin) opens the same picker, and the files are added to
the source's own directory as new tables beside the ones it has. It is
`POST /api/sources/<id>/uploads`, authorized in the source's own workspace,
and every rule above holds, with three more:

| Refused | |
| --- | --- |
| A source that was not made by uploading | another kind, or a DuckDB source over the server's own files, by name |
| A file whose table the source already has | `"budget.csv" would be the table "budget", which is already a table in this source; rename it`, a workbook's sheets included |
| More files than `DUCKDB_UPLOAD_MAX_FILES` in the directory | the files already there count, and each sheet of a workbook once converted |

All or nothing applies to the request's own files: they are received into a
staging directory beside the source's (`uploads/<workspace id>/.adding-<id>`,
which no source can name) and linked into the source's directory only once
all of them are accepted, each under a name created exclusively, so a file
already there is never overwritten, read or removed. A refused or cancelled
request removes the staging directory and exactly the names it linked.

Stored files are not tables yet: the allowlist is never edited by an upload.
When the files are stored, the browser opens the source's
[catalog refresh](/concepts/duckdb-sources/#adding-files-to-an-upload-source),
which offers them as new tables; applying that review adds them. The audit
event is `source.upload` on the source, with `added: true`.

### Orphaned uploads

An upload whose source is never created (the dialog closed, the connection
lost, a refusal in the form) would otherwise stay under `uploads/` forever.
So the server sweeps ([#604](https://github.com/jbouder/holotable/issues/604)):
an `uploads/<workspace>/<directory>` is removed when it is older than an hour
(`UPLOAD_ORPHAN_AGE_MS` in `src/lib/duckdb/uploads.ts`), judged by the newest
change inside it, **and** no source of that workspace, tombstoned ones
included, names it. The sources are read after the directories are listed,
so one created meanwhile counts, and when they cannot be read nothing of
that workspace is removed. The sweep never touches anything outside
`uploads/`, a symlink, or a directory whose workspace segment is not a
workspace id. It runs once at boot, in the background, and after every
successful upload for that workspace, so a long-running server stays clean
without a scheduler. It logs `uploads.swept` with `{ removed, kept }` and
never a path.

Create the source within the hour: an upload left in the form longer than
that may be swept, and **Create source** then answers that the path does not
exist. Upload again.

**The workspace rule.** A path under `uploads/` names its workspace in its
second segment, and a source may name only an upload directory of its own
workspace. That is checked on the path as typed and on where it resolves, so
a symlink elsewhere under the root cannot lead into another workspace's
uploads either. It is checked when the source is saved and again before
every open, the same as the root.

**Deleting.** Deleting an upload source removes its directory, unless
another source in the workspace still names it. That holds when the source
is tombstoned because a dashboard still uses it, too: a tombstoned source
never runs again. Deleting any other DuckDB source removes nothing: what is under the root is the
operator's. An upload whose source is never created is
[swept](#orphaned-uploads) after an hour.

Every upload is audited as `source.upload`, with the file count and total
bytes, or the refusal ([Audit log](/operations/audit-log/)).

## The lock and `allowed_paths`

Each DuckDB source gets its own in-process engine. Before any statement a
panel wrote can run, the engine is locked:

```sql
SET GLOBAL TimeZone='UTC'
SET allowed_paths=['<each file of the source>']
SET enable_external_access=false
SET autoinstall_known_extensions=false
SET autoload_known_extensions=false
SET memory_limit='512MB'
SET threads=2
SET lock_configuration=true
```

A JSON file's view is made with its reader's bounds named:
`maximum_object_size` (`JSON_MAX_OBJECT_BYTES`, 16 MiB per object) and
`sample_size` (`JSON_SAMPLE_ROWS`, 20,480 records typed), so a hostile file
cannot make the reader allocate past them; the memory limit and the query
timeout stay the outer bound
([JSON files](/concepts/duckdb-sources/#json-files)). The `json` extension
is compiled into the binding, so reading JSON needs no install or load.

The zone is a statement rather than an option to the engine, because it is
ICU's setting and the Linux bindings load ICU only after an engine's options
are applied. **Test** reads
the lock back on a live connection and reports it as *Locked*. A lock that
does not hold is shown as a danger-toned finding, not passed over.

`allowed_paths` lists the source's files one by one, not its directory. In
DuckDB 1.5, a statement may write wherever it may read, so allowing a
directory would let a statement that slipped past the SQL guard create a file
beside the source's own. File by file, it cannot. A `.duckdb` source sets no
allowed path at all: its file is opened `READ_ONLY` before the lock.

## The mount

The remaining gap is narrow: a statement could still overwrite one of a
source's own listed files. The SQL guard, which allows exactly one `SELECT`,
is what stops that. Without uploads, the belt behind it is to give the server
**read-only** access to the root:

- **Docker**: `- files:/var/lib/holotable/files:ro`.
- **Kubernetes**: mount the volume with `readOnly: true`
  (`extraVolumes` / `extraVolumeMounts` in the Helm chart), and give the
  pod's file system no write path into it.

[Uploads](#uploads) need the server to write `uploads/` under the root, so
with them on, the server's mount is read-write. To keep the operator's files
read-only all the same, mount the root read-only and a writable volume at
`<root>/uploads` on top of it. The repository's `docker-compose.yml` mounts
the [files demo](/operations/demo-data/#the-files-demo) volume read-write
for the app, so uploads work there; the seeder writes `demo/` and the smoke
test mounts it `:ro`.

Whatever else writes the files (a batch job, a sync from object storage) runs
outside Holotable, with its own credentials.

## Memory, threads and time

| Variable | Default | What it bounds |
| --- | --- | --- |
| `DUCKDB_SOURCES_DIR` | (unset) | The directory DuckDB sources may read. Unset refuses every one. |
| `DUCKDB_MEMORY_LIMIT` | `512MB` | The memory one source's engine may use (`512MB`, `2GB`, `1GiB`). A query that needs more fails with DuckDB's out-of-memory error, not the process's. |
| `DUCKDB_THREADS` | `2` | The threads one source's engine may run a query on. |
| `DUCKDB_UPLOAD_MAX_BYTES` | `52428800` | The largest file one [upload](#uploads) may hold, in bytes. |
| `DUCKDB_UPLOAD_MAX_FILES` | `20` | The most files one upload may hold (at most `200`). |
| `QUERY_TIMEOUT_SECONDS` | `20` | When a running query is interrupted, as on every SQL source. |
| `MAX_QUERY_ROWS`, `MAX_RESULT_BYTES` | `5000`, `4 MiB` | The rows and bytes a result may carry. A cut travels as `truncated` to a badge on the panel. |

The engine runs inside the server process, so its memory is the pod's
memory. The worst case is `DUCKDB_MEMORY_LIMIT` times the DuckDB sources in
use at once, on top of the server's own heap
([Sizing memory and pollers](/admin/sizing/)). Two sources at the defaults
add up to a gigabyte. Size the container for that, or lower the limit. An
engine lives as long as its source is unchanged. Changing its path or
allowlist reopens it, and shutdown closes every engine.

Query latency, outcomes and row counts are in
`holotable_query_duration_seconds` and `holotable_query_rows` with the source
as a label, as on every kind ([Prometheus metrics](/operations/metrics/)).

## The binding and the image

DuckDB is the native module `@duckdb/node-api`, with a prebuilt binding per
platform. It loads lazily, the first time a DuckDB source needs it, so a
server whose platform has no binding still boots and serves every other kind.
There the card is hidden, and saving, testing or running a DuckDB source says
"DuckDB is not available on this server". The failed load is logged once, as
a warning with its error code.

| Image | Base | Binding |
| --- | --- | --- |
| `ghcr.io/jbouder/holotable` (production) | `node:24-bookworm-slim` | glibc, `linux-x64` and `linux-arm64` |
| `ghcr.io/jbouder/holotable:quickstart` | Alpine | musl, `linux-x64` and `linux-arm64` |

Both load it. **The quick-start image** sets
`DUCKDB_SOURCES_DIR=/var/lib/holotable/files`, writable by its app user, and
runs in [local mode](/admin/demo-mode/#local-mode), whose owner is a source
admin, so **Upload files** works out of the box and the seeder writes the
[files demo](/operations/demo-data/#the-files-demo) under `demo/`. Keep uploads
across runs with a volume at the root
(`-v holotable-files:/var/lib/holotable/files`). To read a directory of your
own as well, mount it read-only *under* the root, where the path picker offers
it beside the files demo:
`docker run -v "$PWD/files:/var/lib/holotable/files/mine:ro" …`.

## What is out of scope

- **Remote files.** `s3://`, `https://`, `httpfs` and the like are refused by
  the guard and by the locked engine. A file is local to the server; remote
  object storage is an operator's mount (a CSI driver, `rclone mount`, a
  sync job), not Holotable's fetch.
- **MotherDuck.** It needs credentials and the network; it would be a kind of
  its own.
- **Hot reload.** The catalog is what the last **Refresh** found. A new file
  in an upload source's directory is offered as a new table by the next
  refresh; in a directory of the server's own, it is added by editing the
  source and discovering its tables again. A file
  replaced under the same name is read fresh on the next query, with no
  refresh needed.
- **Writing, importing or converting.** Holotable reads. `COPY`, `CREATE`,
  `INSERT` and `ATTACH` stay refused. [Uploads](#uploads) store a CSV or
  JSON file as it was sent, and nested JSON is not flattened (a query reads
  a `STRUCT` field directly); the one conversion is an `.xlsx` or `.xlsm` workbook's
  sheets to CSV, on arrival ([Workbooks](#workbooks)).
- **Other upload formats, quotas and replacing a file.** Uploads take CSV,
  JSON, `.xlsx` and `.xlsm`; `.xls`, `.xlsb`, `.ods` and `.numbers` are
  refused, as are a sheet or range picker and keeping the workbook to
  convert again. There is no per-workspace disk quota beyond the per-file
  and per-upload caps, and no replacing or deleting a single file of an
  upload source: add it under a new name, or make a new source.
