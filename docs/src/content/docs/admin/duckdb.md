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
the root. Those are what the path picker offers:

```
/var/lib/holotable/files/
├── requests/                 a source: one table per file
│   ├── http_requests.parquet
│   └── hosts.csv
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

A source admin can also make a DuckDB source from CSV files uploaded in the
browser ([#595](https://github.com/jbouder/holotable/issues/595)), with no
access to the server: **Add source → Upload files**. The files land under the
same root, never a second one:

```
/var/lib/holotable/files/
└── uploads/
    └── <workspace id>/
        └── 3f9c0a51d2e47b86/          one upload: a fresh random id
            ├── household_expenses.csv
            └── budget_2026.csv
```

Each file is named by its own stem, lowercased and reduced to `[a-z0-9_]`
(`Budget 2026.csv` is `budget_2026`; a stem that starts with a digit gets
`t_` in front), because that is the table's name. The source stores the
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
| A file that is not text: a NUL byte, or not UTF-8, in its first 64 KiB | whatever its name or content type says |
| An empty file, a name that reduces to nothing, two files that would be one table | |

The file is streamed to disk as it arrives and never held whole in memory.
A malformed bound is a warning in development (the default is used) and a
startup error in production; set without `DUCKDB_SOURCES_DIR`, it is a
warning, since no upload can land.

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
operator's. An upload whose source is never created stays under `uploads/`
until someone removes it.

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

Both load it. **The quick-start image ships no sample files** and sets no
`DUCKDB_SOURCES_DIR`, so its DuckDB and Upload files cards are hidden (and
its demo sign-in, at most an editor, could not manage a source anyway). To try a DuckDB source
there, mount a directory and name it:
`docker run -v "$PWD/files:/files:ro" -e DUCKDB_SOURCES_DIR=/files …`. The
Docker Compose stack has a [files demo](/operations/demo-data/#the-files-demo)
with a seeded source and dashboard.

## What is out of scope

- **Remote files.** `s3://`, `https://`, `httpfs` and the like are refused by
  the guard and by the locked engine. A file is local to the server; remote
  object storage is an operator's mount (a CSI driver, `rclone mount`, a
  sync job), not Holotable's fetch.
- **MotherDuck.** It needs credentials and the network; it would be a kind of
  its own.
- **Hot reload.** The catalog is what the last **Refresh** found. A new file
  in a source's directory becomes a table on the next refresh. A file
  replaced under the same name is read fresh on the next query, with no
  refresh needed.
- **Writing, importing or converting.** Holotable reads. `COPY`, `CREATE`,
  `INSERT` and `ATTACH` stay refused. [Uploads](#uploads) store a CSV file
  as it was sent; nothing converts it.
- **Other upload formats, quotas and replacing a file.** Uploads take CSV.
  There is no per-workspace disk quota beyond the per-file and per-upload
  caps, and no replacing a file in place: upload again and make a new
  source.
