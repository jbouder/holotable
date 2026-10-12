---
title: DuckDB files
description: Letting DuckDB sources read files on the server — the root, the lock and allowed paths, the read-only mount, the memory and thread bounds, and the binding.
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
[row-level filter](/admin/row-level-filters/).

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

## Mount it read-only

The remaining gap is narrow: a statement could still overwrite one of a
source's own listed files. The SQL guard, which allows exactly one `SELECT`,
is what stops that. The recommended belt behind it is to give the server
**read-only** access to the root:

- **Docker / Compose**: `- files:/var/lib/holotable/files:ro`. The repository's
  `docker-compose.yml` does exactly this for the
  [files demo](/operations/demo-data/#the-files-demo). The seeder mounts the
  volume read-write and is its only writer; the app and the smoke test mount
  it `:ro`.
- **Kubernetes**: mount the volume with `readOnly: true`
  (`extraVolumes` / `extraVolumeMounts` in the Helm chart), and give the
  pod's file system no write path into it.

Whatever writes the files (a batch job, a sync from object storage) runs
outside Holotable, with its own credentials.

## Memory, threads and time

| Variable | Default | What it bounds |
| --- | --- | --- |
| `DUCKDB_SOURCES_DIR` | (unset) | The directory DuckDB sources may read. Unset refuses every one. |
| `DUCKDB_MEMORY_LIMIT` | `512MB` | The memory one source's engine may use (`512MB`, `2GB`, `1GiB`). A query that needs more fails with DuckDB's out-of-memory error, not the process's. |
| `DUCKDB_THREADS` | `2` | The threads one source's engine may run a query on. |
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
`DUCKDB_SOURCES_DIR`, so its DuckDB card is hidden. To try a DuckDB source
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
  `INSERT` and `ATTACH` stay refused.
