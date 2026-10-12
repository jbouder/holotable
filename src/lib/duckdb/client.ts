import { readdir, realpath, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import type { DuckDBConnection, DuckDBInstance, DuckDBValue } from "@duckdb/node-api";
import { DUCKDB_MEMORY, config } from "@/lib/config";
import {
  type DuckDbBinding,
  DUCKDB_UNAVAILABLE,
  duckdbBinding,
} from "@/lib/duckdb/binding";
import {
  DuckDbPathError,
  isInside,
  type ResolvedSourcePath,
  resolveSourcePath,
} from "@/lib/duckdb/path";
import { observeQuery, recordTruncation } from "@/lib/metrics";
import { trackInFlight } from "@/lib/shutdown";
import { MAX_TABLES } from "@/lib/sources/catalog";
import { QueryExecutionError, type QueryResult } from "@/lib/sources/execution";
import type { DuckDbSourceRecord } from "@/lib/sources/kinds/duckdb";
import { type ExecutablePlan, POSITION_COLUMN, TOTAL_COLUMN } from "@/lib/sql/safety";
import { ResultCollector } from "@/lib/sql/result-cap";
import type { Truncation } from "@/lib/truncation";

/**
 * The DuckDB engine behind a source (#572): one in-process instance per
 * source, opened, locked, and then only ever read.
 *
 * A directory opens in memory with one view per Parquet or CSV file directly
 * under it; a `.duckdb` file opens `READ_ONLY`. Then, before anything a panel
 * wrote can run, the instance is locked: external access off except for the
 * source's own directory, no extension installed or autoloaded, a memory and
 * thread cap, and `lock_configuration`, after which no statement can change
 * any of it. The SQL guard is the first belt; this is the second, so a
 * statement the guard missed still cannot read another file, attach a
 * database, load an extension or reach the network.
 *
 * Nothing here logs or returns a path: an engine's own error messages name
 * the files they failed on, so every message is scrubbed before it leaves.
 */

/** Opened instances, by source id. */
interface Engine {
  /** What the instance was opened for; a different config reopens it. */
  key: string;
  instance: DuckDBInstance;
  resolved: ResolvedSourcePath;
  /** The views a directory was opened with, by name. Empty for a database. */
  views: string[];
  /** Queries holding a connection on it. */
  active: number;
  /** Replaced or disposed: closed once the last query releases it. */
  retired: boolean;
}

const engines = new Map<string, Promise<Engine>>();

/** What changes the instance a source needs: where it is and what it may read. */
function engineKey(source: DuckDbSourceRecord, resolved: ResolvedSourcePath): string {
  return JSON.stringify([
    resolved.absolute,
    resolved.layout,
    source.config.tables.map((t) => t.name).sort(),
  ]);
}

/** A memory limit fit to interpolate: `DUCKDB_MEMORY_LIMIT`, checked again here. */
function memoryLimit(): string {
  const value = config.duckdbMemoryLimit;
  if (!DUCKDB_MEMORY.test(value)) {
    throw new Error("DUCKDB_MEMORY_LIMIT must be a size such as 512MB or 2GB");
  }
  return value;
}

function threads(): number {
  const value = config.duckdbThreads;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("DUCKDB_THREADS must be a positive integer");
  }
  return value;
}

/** A string as a SQL literal. */
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** A name as a quoted SQL identifier. */
function identifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

const READERS: Record<string, string> = {
  ".parquet": "read_parquet",
  ".csv": "read_csv",
};

/** A file a directory source reads, and the view it becomes. */
export interface DirectoryFile {
  /** The view name: the file name without its extension. */
  name: string;
  /** Resolved, and inside the source's directory. */
  absolute: string;
  reader: string;
}

/**
 * The Parquet and CSV files directly under a directory, by stem; not
 * recursive. A symlink is followed and kept only when it resolves to a
 * regular file inside the directory, so a link cannot make a view of a file
 * elsewhere. Two files with one stem (`a.parquet`, `a.csv`) make one view,
 * from the Parquet file. At most {@link MAX_TABLES}, in name order.
 */
export async function listDirectoryFiles(dir: string): Promise<DirectoryFile[]> {
  const entries = (await readdir(dir)).sort();
  const byName = new Map<string, DirectoryFile>();
  for (const entry of entries) {
    const ext = extname(entry).toLowerCase();
    const reader = READERS[ext];
    if (!reader) continue;
    const name = entry.slice(0, -ext.length);
    if (name.length === 0 || name.length > 128) continue;
    let absolute: string;
    try {
      absolute = await realpath(join(dir, entry));
      if (!isInside(dir, absolute) || !(await stat(absolute)).isFile()) continue;
    } catch {
      continue;
    }
    const prior = byName.get(name);
    if (prior && prior.reader === "read_parquet") continue;
    byName.set(name, { name, absolute, reader });
  }
  return [...byName.values()].slice(0, MAX_TABLES);
}

/**
 * The statements that lock an instance, in the order they must run:
 * `allowed_paths` cannot be set once external access is off, and nothing can
 * be set once the configuration is locked.
 *
 * `TimeZone` comes first, `GLOBAL` so it is every later connection's zone:
 * the plan binds its window as UTC `TIMESTAMP`s, and a `TIMESTAMPTZ` column
 * compares to one in this zone. It is a statement rather than an instance
 * option because the setting belongs to ICU, which the Linux bindings load
 * only after the options are applied: as an option it failed every open on
 * Linux, in every image (#574).
 *
 * `allowed_paths` names the directory's files one by one, the views' and no
 * other, rather than `allowed_directories` naming the directory: DuckDB
 * allows a write wherever it allows a read, and a directory prefix would let
 * a statement the guard missed create files beside the source's own (#572).
 * A database file needs none: it is open before the lock, `READ_ONLY`.
 */
export function lockStatements(files: readonly string[]): string[] {
  return [
    "SET GLOBAL TimeZone='UTC'",
    ...(files.length === 0
      ? []
      : [`SET allowed_paths=[${files.map(literal).join(", ")}]`]),
    "SET enable_external_access=false",
    "SET autoinstall_known_extensions=false",
    "SET autoload_known_extensions=false",
    `SET memory_limit=${literal(memoryLimit())}`,
    `SET threads=${threads()}`,
    "SET lock_configuration=true",
  ];
}

/**
 * What the plan dialog shows of the session: the lock as it runs, with the
 * files named by their role, never their paths.
 */
export function sessionStatements(layout: "directory" | "database"): string[] {
  return lockStatements(layout === "directory" ? ["<each file of the source>"] : []);
}

/**
 * Open and lock an instance for a resolved path. Not cached: the executor
 * caches through {@link engineFor}; refresh and Test open their own, so what
 * they report is what a fresh open finds.
 */
export async function openEngine(
  binding: DuckDbBinding,
  resolved: ResolvedSourcePath,
): Promise<{ instance: DuckDBInstance; views: string[] }> {
  // The zone is set by the first lock statement, not here (lockStatements).
  const options: Record<string, string> = {
    threads: String(threads()),
    memory_limit: memoryLimit(),
  };
  if (resolved.layout === "database") options.access_mode = "READ_ONLY";
  // A file that is not a database (or is locked by a writer) fails here,
  // and the engine's message names it: scrubbed like every other.
  const instance = await binding.DuckDBInstance.create(
    resolved.layout === "database" ? resolved.absolute : ":memory:",
    options,
  ).catch((err: unknown) => {
    throw new QueryExecutionError(
      `could not open the DuckDB source: ${scrub(err, resolved)}`,
    );
  });
  const connection = await instance.connect();
  const views: string[] = [];
  const files: string[] = [];
  try {
    if (resolved.layout === "directory") {
      for (const file of await listDirectoryFiles(resolved.absolute)) {
        await connection.run(
          `CREATE VIEW ${identifier(file.name)} AS SELECT * FROM ${file.reader}(${literal(file.absolute)})`,
        );
        views.push(file.name);
        files.push(file.absolute);
      }
    }
    for (const statement of lockStatements(files)) {
      await connection.run(statement);
    }
    const locked = await lockHolds(connection);
    if (!locked) throw new Error("the DuckDB configuration did not lock");
  } catch (err) {
    connection.closeSync();
    instance.closeSync();
    throw new QueryExecutionError(
      `could not open the DuckDB source: ${scrub(err, resolved)}`,
    );
  }
  connection.closeSync();
  return { instance, views };
}

/**
 * Whether the lock holds on a connection: external access off and the
 * configuration locked, read from the connection's own settings. Never
 * probed with a read, which would prove only that one path was refused.
 */
export async function lockHolds(connection: DuckDBConnection): Promise<boolean> {
  const reader = await connection.runAndReadAll(
    "SELECT current_setting('enable_external_access') AS external, current_setting('lock_configuration') AS locked",
  );
  const [row] = reader.getRowObjectsJS();
  return row?.external === false && row?.locked === true;
}

/** The binding and the resolved path, or the refusal a panel or an admin is shown. */
async function prepare(source: {
  config: { path: string };
}): Promise<{ binding: DuckDbBinding; resolved: ResolvedSourcePath }> {
  const binding = await duckdbBinding();
  if (!binding) throw new QueryExecutionError(DUCKDB_UNAVAILABLE);
  try {
    return { binding, resolved: await resolveSourcePath(source.config.path) };
  } catch (err) {
    if (err instanceof DuckDbPathError) throw new QueryExecutionError(err.message);
    throw err;
  }
}

/** The source's engine, opened once and reopened when its config changes. */
async function engineFor(source: DuckDbSourceRecord): Promise<Engine> {
  const { binding, resolved } = await prepare(source);
  const key = engineKey(source, resolved);
  const existing = engines.get(source.id);
  if (existing) {
    const engine = await existing.catch(() => null);
    if (engine && engine.key === key && !engine.retired) return engine;
    if (engines.get(source.id) === existing) engines.delete(source.id);
    if (engine) retire(engine);
  }
  // Re-checked after the await above: another query may have opened it.
  const raced = engines.get(source.id);
  if (raced) return raced;
  const opening = openEngine(binding, resolved).then(({ instance, views }) => ({
    key,
    instance,
    resolved,
    views,
    active: 0,
    retired: false,
  }));
  engines.set(source.id, opening);
  opening.catch(() => {
    if (engines.get(source.id) === opening) engines.delete(source.id);
  });
  return opening;
}

/**
 * The source's engine, held for one query: counted active in the same turn
 * it is found live, so a retire in between can never close it under the
 * query.
 */
async function acquire(source: DuckDbSourceRecord): Promise<Engine> {
  for (;;) {
    const engine = await engineFor(source);
    if (!engine.retired) {
      engine.active += 1;
      return engine;
    }
  }
}

function retire(engine: Engine): void {
  engine.retired = true;
  if (engine.active === 0) engine.instance.closeSync();
}

/**
 * A plan's parameters as DuckDB values. The window's bounds are UTC
 * `TIMESTAMP`s (the plan casts them so), a multi-value variable is a list,
 * and everything else is the string it was bound as.
 */
function bindValues(binding: DuckDbBinding, params: unknown[]): DuckDBValue[] {
  return params.map((value) => {
    if (value instanceof Date) {
      return binding.timestampValue(BigInt(value.getTime()) * BigInt(1000));
    }
    if (Array.isArray(value)) return binding.listValue(value.map(String));
    if (typeof value === "string" || typeof value === "number" || value === null) {
      return value;
    }
    throw new Error(`unsupported plan parameter: ${typeof value}`);
  });
}

/**
 * A value as the JSON the client receives: a timestamp as ISO 8601 (as the
 * PostgreSQL path sends one), a big integer as a number when it fits and a
 * string when it does not, a non-finite float as null.
 */
export function serializableValue(value: unknown): unknown {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "bigint") {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) &&
      value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (Array.isArray(value)) return value.map(serializableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, serializableValue(v)]),
    );
  }
  return value;
}

/**
 * An engine error's message with every path taken out: the resolved root and
 * source path by name, and any other quoted absolute path as `<path>`.
 */
export function scrub(err: unknown, resolved?: ResolvedSourcePath): string {
  let message = err instanceof Error ? err.message : String(err);
  if (resolved) {
    message = message
      .replaceAll(resolved.absolute, "<source>")
      .replaceAll(resolved.root, "<DUCKDB_SOURCES_DIR>");
  }
  return message.replace(/(["'])\/[^"'\n]*\1/g, "$1<path>$1").split("\n")[0];
}

/**
 * The server wraps the query and filters time on `_holo.<timeField>`; a
 * query that does not produce that column fails to bind. Named as the
 * PostgreSQL path names it, so the author is told what to change.
 */
function isMissingTimeField(message: string, timeField?: string): boolean {
  if (!timeField) return false;
  const lower = message.toLowerCase();
  return lower.includes("binder error") && lower.includes(timeField.toLowerCase());
}

const timeoutMessage = () =>
  `the query ran longer than QUERY_TIMEOUT_SECONDS (${config.queryTimeoutSeconds}s) and was stopped. Narrow the time range or aggregate.`;

/**
 * Run a guarded plan, bounded in time (an `interrupt()` at
 * `QUERY_TIMEOUT_SECONDS`), rows (the plan's cap) and bytes (the collector's),
 * on a connection of its own that is closed after. Counted in flight so a
 * graceful shutdown waits for it, and timed for `/api/metrics` by source.
 */
export function executeDuckDbPlan(
  source: DuckDbSourceRecord,
  plan: ExecutablePlan,
): Promise<QueryResult> {
  return trackInFlight(async () => {
    const startedAt = performance.now();
    try {
      const result = await runPlan(source, plan);
      observeQuery({
        sourceId: source.id,
        seconds: (performance.now() - startedAt) / 1000,
        ok: true,
        rows: result.rows.length,
      });
      return result;
    } catch (err) {
      observeQuery({
        sourceId: source.id,
        seconds: (performance.now() - startedAt) / 1000,
        ok: false,
      });
      throw err;
    }
  });
}

async function runPlan(
  source: DuckDbSourceRecord,
  plan: ExecutablePlan,
): Promise<QueryResult> {
  const binding = await duckdbBinding();
  if (!binding) throw new QueryExecutionError(DUCKDB_UNAVAILABLE);
  const engine = await acquire(source);
  let connection: DuckDBConnection | undefined;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    connection?.interrupt();
  }, config.queryTimeoutSeconds * 1000);
  try {
    connection = await engine.instance.connect();
    const result = await connection.stream(plan.sql, bindValues(binding, plan.params));
    const names = result.columnNames();
    const collector = new ResultCollector(config.maxResultBytes);
    let total: number | undefined;
    while (!collector.exceeded) {
      const chunk = await result.fetchChunk();
      if (!chunk || chunk.rowCount === 0) break;
      for (const values of chunk.convertRows(binding.JSDuckDBValueConverter)) {
        const row: Record<string, unknown> = {};
        names.forEach((name, i) => {
          row[name] = serializableValue(values[i]);
        });
        if (plan.ranked) {
          total ??= Number(row[TOTAL_COLUMN]);
          delete row[TOTAL_COLUMN];
          delete row[POSITION_COLUMN];
        }
        if (!collector.push(row)) break;
      }
    }
    if (collector.exceeded) throw new QueryExecutionError(collector.exceededMessage());

    const columns = names.filter(
      (name) => !plan.ranked || (name !== TOTAL_COLUMN && name !== POSITION_COLUMN),
    );
    const rows = collector.rows;
    let truncated: Truncation | undefined;
    if (plan.ranked) {
      if (total !== undefined && total > rows.length) {
        truncated = { stage: "rows", kept: rows.length, total };
      }
    } else if (plan.maxRows !== undefined && rows.length > plan.maxRows) {
      // The plan asked for one past the cap to see the cut; that row goes.
      rows.length = plan.maxRows;
      truncated = { stage: "rows", kept: rows.length };
    }
    if (truncated) recordTruncation(truncated.stage);
    return { columns, rows, ...(truncated ? { truncated } : {}) };
  } catch (err) {
    if (err instanceof QueryExecutionError) throw err;
    if (timedOut) throw new QueryExecutionError(timeoutMessage());
    const message = scrub(err, engine.resolved);
    if (isMissingTimeField(message, plan.timeField)) {
      throw new QueryExecutionError(
        `time column "${plan.timeField}" is not produced by this query. Set the ` +
          `panel's timeField to the SELECT output alias of your time bucket ` +
          `(e.g. time_bucket(...) AS ${plan.timeField}), or clear it when the ` +
          `result has no time column.`,
      );
    }
    throw new QueryExecutionError(message);
  } finally {
    clearTimeout(timer);
    connection?.closeSync();
    engine.active -= 1;
    if (engine.retired && engine.active === 0) engine.instance.closeSync();
  }
}

/** One column of a table, as introspection reads it. */
export interface IntrospectedTable {
  name: string;
  columns: { column_name: string; data_type: string }[];
}

/**
 * Every table and view in `main`, with its columns: for a directory, one per
 * file; for a database, its own tables. Read on a freshly opened, locked
 * instance, which is closed after. Only the path is read, so discovery can
 * ask about a source that does not exist yet (#573).
 */
export async function introspect(source: { config: { path: string } }): Promise<{
  tables: IntrospectedTable[];
  version: string;
}> {
  const { binding, resolved } = await prepare(source);
  const { instance } = await openEngine(binding, resolved);
  const connection = await instance.connect();
  try {
    const reader = await connection.runAndReadAll(
      `SELECT table_name, column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = 'main'
        ORDER BY table_name, ordinal_position`,
    );
    const byTable = new Map<string, IntrospectedTable>();
    for (const row of reader.getRowObjectsJS()) {
      const name = String(row.table_name);
      const table = byTable.get(name) ?? { name, columns: [] };
      table.columns.push({
        column_name: String(row.column_name),
        data_type: String(row.data_type),
      });
      byTable.set(name, table);
    }
    return { tables: [...byTable.values()], version: await engineVersion(connection) };
  } catch (err) {
    throw new QueryExecutionError(scrub(err, resolved));
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

/** `version()` without its leading `v`: `1.5.6`. */
async function engineVersion(connection: DuckDBConnection): Promise<string> {
  const reader = await connection.runAndReadAll("SELECT version() AS version");
  const version = String(reader.getRowObjectsJS()[0]?.version ?? "unknown");
  return version.replace(/^v/, "").slice(0, 64) || "unknown";
}

/** What a Test found, in the kind's own terms. */
export interface DuckDbTestFacts {
  openMs: number;
  queryMs: number;
  version: string;
  locked: boolean;
  tables: { table: string; reachable: boolean; error?: string }[];
}

/**
 * Open the source as an execution would, then read whether the lock holds
 * and whether each allowlisted table is there, with `LIMIT 0` so a check
 * costs a plan and no rows. Throws a {@link QueryExecutionError} with a
 * path-free message when the path does not resolve or the engine will not
 * open.
 */
export async function testDuckDbSource(
  source: DuckDbSourceRecord,
): Promise<DuckDbTestFacts> {
  return trackInFlight(async () => {
    const { binding, resolved } = await prepare(source);
    const startedAt = performance.now();
    const { instance } = await openEngine(binding, resolved);
    const openMs = performance.now() - startedAt;
    const connection = await instance.connect();
    try {
      const queryStartedAt = performance.now();
      const version = await engineVersion(connection);
      const queryMs = performance.now() - queryStartedAt;
      const locked = await lockHolds(connection);
      const tables: DuckDbTestFacts["tables"] = [];
      for (const table of source.config.tables) {
        try {
          await connection.run(`SELECT 1 FROM ${identifier(table.name)} LIMIT 0`);
          tables.push({ table: table.name, reachable: true });
        } catch (err) {
          tables.push({
            table: table.name,
            reachable: false,
            error: scrub(err, resolved),
          });
        }
      }
      return { openMs, queryMs, version, locked, tables };
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  });
}

/** Close a source's engine, for a source that is going away. */
export async function disposeDuckDbSource(sourceId: string): Promise<void> {
  const existing = engines.get(sourceId);
  if (!existing) return;
  engines.delete(sourceId);
  const engine = await existing.catch(() => null);
  if (engine) retire(engine);
}

/** Close every engine, at shutdown. */
export async function closeDuckDbSources(): Promise<void> {
  await Promise.all([...engines.keys()].map((id) => disposeDuckDbSource(id)));
}
