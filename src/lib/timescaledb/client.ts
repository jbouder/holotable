import { Client, Query } from "pg";
import type { SourceRecord } from "@/lib/registry";
import { resolveCredentials } from "@/lib/secrets/credentials";
import { config } from "@/lib/config";
import type { ExecutablePlan } from "@/lib/sql/safety";
import { ResultCollector } from "@/lib/timescaledb/result-cap";
import { observeQuery } from "@/lib/metrics";
import { trackInFlight } from "@/lib/shutdown";
import { isPlainIdentifier } from "@/lib/catalog/identifiers";
import type { SourceTestResult, TestReadOnly, TestTable } from "@/lib/source-test";

function clientFor(source: SourceRecord): Client {
  // Re-authorized on every connection: the ref must still be granted to the
  // workspace this source belongs to, whatever it was granted when saved.
  const credentials = resolveCredentials(source.secretRef, source.workspaceId);
  return new Client({
    host: source.config.host,
    port: source.config.port,
    database: source.config.database,
    user: credentials.username,
    password: credentials.password,
    ssl: source.config.ssl,
    connectionTimeoutMillis: (config.queryTimeoutSeconds + 5) * 1000,
    statement_timeout: config.queryTimeoutSeconds * 1000,
    application_name: "holotable",
  });
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

/**
 * A SQL statement failed at execution time (as opposed to a connection or
 * infrastructure failure). The message is safe to surface to an authorized
 * editor — it is the same information the live poller already forwards — and
 * routes translate it into a 400 so the user can correct the query and retry.
 */
export class QueryExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryExecutionError";
  }
}

/**
 * Postgres tags statement-level failures (syntax, unknown column, type
 * mismatch, timeouts, …) with a 5-character SQLSTATE `code`. Connection and
 * socket failures surface Node error codes like `ECONNREFUSED` instead, which
 * we deliberately do NOT surface to the client.
 */
function isPostgresStatementError(
  err: unknown,
): err is { code: string; message: string } {
  const e = err as { code?: unknown };
  return typeof e?.code === "string" && /^[0-9A-Z]{5}$/.test(e.code);
}

/**
 * The server wraps the validated query and filters time on `_holo.<timeField>`.
 * If the declared `timeField` is not a column produced by the query, Postgres
 * raises `42703` ("column _holo.<field> does not exist"). Turn that opaque
 * failure into an actionable message: the panel must alias its time bucket to
 * the declared `timeField` (or clear it for non-time results).
 */
function isMissingTimeFieldError(err: unknown, timeField?: string): boolean {
  if (!timeField) return false;
  const e = err as { code?: unknown; message?: unknown };
  if (e?.code !== "42703") return false;
  const message = typeof e.message === "string" ? e.message.toLowerCase() : "";
  return message.includes(`_holo.${timeField.toLowerCase()}`);
}

/**
 * Pin the session `search_path` to the source's configured schema (where the
 * allowlisted tables live) plus `public` (where the TimescaleDB extension
 * installs functions like `time_bucket`). The catalog advertises bare table
 * names, so unqualified references must resolve against the configured schema.
 * Table access stays gated by the allowlist in `validateSql`, independent of
 * `search_path`. `schema` is admin-configured; reject anything that is not a
 * plain identifier rather than interpolate it unquoted.
 */
function searchPathStatement(schema: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(schema)) {
    throw new Error(`invalid source schema: ${schema}`);
  }
  return `SET LOCAL search_path TO "${schema}", public`;
}

/**
 * Everything the session is put into before a plan runs, in order.
 *
 * Exported because `/api/sql/plan` shows it to the author (#110): the claim
 * that execution is read-only and schema-pinned is only worth making if what
 * is shown is what runs, so both read this one list rather than describing it
 * twice.
 */
export function sessionStatements(schema: string): string[] {
  return [READ_ONLY_TRANSACTION, searchPathStatement(schema)];
}

const READ_ONLY_TRANSACTION = "BEGIN TRANSACTION READ ONLY";

/** Postgres returns `Date` for timestamps; the client receives ISO strings. */
function serializableRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Date ? value.toISOString() : value,
    ]),
  );
}

/**
 * Run the statement and collect its rows one at a time, bounded by
 * `maxBytes` of serialized output. Attaching a `row` listener stops `pg` from
 * buffering the full result itself, so the collector's cap — not the row
 * `LIMIT` — is what bounds memory: once it is crossed, further rows are
 * dropped as they arrive and the statement fails with a message naming the
 * limit instead of an oversized payload (or an out-of-memory crash) later on.
 */
function collectResult(
  client: Client,
  plan: ExecutablePlan,
  maxBytes: number,
): Promise<QueryResult> {
  return new Promise((resolve, reject) => {
    const collector = new ResultCollector(maxBytes);
    const query = new Query<Record<string, unknown>>(plan.sql, plan.params);
    query.on("row", (row) => {
      collector.push(serializableRow(row));
    });
    query.on("error", reject);
    query.on("end", (result) => {
      if (collector.exceeded) {
        reject(new QueryExecutionError(collector.exceededMessage()));
        return;
      }
      resolve({
        columns: result.fields.map((field) => field.name),
        rows: collector.rows,
      });
    });
    client.query(query);
  });
}

/**
 * Execute a guarded plan in a read-only transaction.
 *
 * Counted as in flight so graceful shutdown (#47) waits for it: each execution
 * opens its own short-lived `Client`, so there is no pool whose `end()` would
 * do the waiting for us.
 *
 * Timed for `/api/metrics` (#51). The measurement spans connect, the
 * read-only transaction and the rollback, not just the statement, because
 * that is the latency a panel actually waits out. The source id is the only
 * label; the statement and the error message never become one.
 */
export function executePlan(
  source: SourceRecord,
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

async function runPlan(source: SourceRecord, plan: ExecutablePlan): Promise<QueryResult> {
  const client = clientFor(source);
  let transactionStarted = false;
  try {
    await client.connect();
    const [transaction, searchPath] = sessionStatements(source.config.schema);
    await client.query(transaction);
    transactionStarted = true;
    await client.query(searchPath);
    return await collectResult(client, plan, config.maxResultBytes);
  } catch (err) {
    if (isMissingTimeFieldError(err, plan.timeField)) {
      throw new QueryExecutionError(
        `time column "${plan.timeField}" is not produced by this query. Set the ` +
          `panel's timeField to the SELECT output alias of your time bucket ` +
          `(e.g. time_bucket(...) AS ${plan.timeField}), or clear it when the ` +
          `result has no time column.`,
      );
    }
    // Surface statement-level SQL failures (bad column, syntax, timeout) so the
    // user can fix the query; leave connection/infra errors to a generic 500.
    if (isPostgresStatementError(err)) {
      throw new QueryExecutionError(err.message);
    }
    throw err;
  } finally {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    await client.end().catch(() => undefined);
  }
}

/**
 * Connectivity, identity and read-only proof for a source (#126).
 *
 * Everything happens inside the same `BEGIN TRANSACTION READ ONLY` the poller
 * uses, and the transaction is always rolled back — which is what makes the
 * write probe below safe to run at all: Postgres makes DDL transactional, so a
 * temp table created by the probe cannot survive the `ROLLBACK` in `finally`
 * even in the case where the server unexpectedly allows it.
 *
 * Each optional step runs inside its own savepoint. A failed statement aborts
 * a Postgres transaction outright, so without them the first unreadable table
 * would make every later check report the same "current transaction is
 * aborted" instead of its own answer.
 */
export function testSource(source: SourceRecord): Promise<SourceTestResult> {
  return trackInFlight(() => runSourceTest(source));
}

/** A statement's SQLSTATE, when it has one. */
function sqlState(err: unknown): string | null {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" ? code : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `25006` — "cannot execute … in a read-only transaction". The healthy answer. */
const READ_ONLY_SQLSTATE = "25006";

/**
 * Run `body` so that its failure costs only itself.
 *
 * Returns the value, or the error. The `ROLLBACK TO` is issued on both paths:
 * releasing a savepoint that was never used is cheap, and forgetting it on the
 * success path would leave a growing stack across a two-hundred-table catalog.
 */
async function inSavepoint<T>(
  client: Client,
  name: string,
  body: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  await client.query(`SAVEPOINT ${name}`);
  try {
    const value = await body();
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    return { ok: true, value };
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => undefined);
    return { ok: false, error };
  }
}

async function runSourceTest(source: SourceRecord): Promise<SourceTestResult> {
  const client = clientFor(source);
  let connected = false;
  try {
    const startedAt = Date.now();
    await client.connect();
    connected = true;
    const connectMs = Date.now() - startedAt;

    await client.query(READ_ONLY_TRANSACTION);
    await client.query(searchPathStatement(source.config.schema));

    const queryStartedAt = Date.now();
    const identity = await client.query<{
      version: string;
      current_user: string;
      session_user: string;
      search_path: string;
      timescaledb: string | null;
    }>(
      `SELECT version() AS version,
              current_user,
              session_user,
              current_setting('search_path') AS search_path,
              (SELECT extversion FROM pg_extension WHERE extname = 'timescaledb')
                AS timescaledb`,
    );
    const queryMs = Date.now() - queryStartedAt;
    const row = identity.rows[0];

    return {
      ok: true,
      message: "connection succeeded",
      latency: { connectMs, queryMs },
      server: { version: row.version, timescaledb: row.timescaledb },
      role: {
        currentUser: row.current_user,
        sessionUser: row.session_user,
        searchPath: row.search_path,
      },
      readOnly: await proveReadOnly(client),
      tables: await checkTables(client, source),
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  } finally {
    if (connected) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    await client.end().catch(() => undefined);
  }
}

/**
 * Attempt a harmless write and report that the server refused it.
 *
 * The transaction is already `READ ONLY`, so the refusal is the expected
 * outcome and the interesting case is the other one: a write that succeeds
 * means this role is more privileged than every guarantee downstream assumes,
 * and the operator needs to be told in those words rather than shown a tick.
 */
async function proveReadOnly(client: Client): Promise<TestReadOnly> {
  const probe = await inSavepoint(client, "holo_write_probe", () =>
    client.query("CREATE TEMP TABLE _holo_write_probe (i integer)"),
  );

  if (probe.ok) {
    return {
      verdict: "accepted",
      detail:
        "CREATE TEMP TABLE succeeded inside a READ ONLY transaction. The " +
        "statement was rolled back, but this role is not read-only.",
    };
  }
  if (sqlState(probe.error) === READ_ONLY_SQLSTATE) {
    return { verdict: "refused", detail: errorMessage(probe.error) };
  }
  // Refused, but for some other reason — no temp schema, a permission denial,
  // a proxy rewriting the statement. Reported as unproven rather than as a
  // pass: this check only means something when the reason is the right one.
  return {
    verdict: "unknown",
    detail: errorMessage(probe.error),
  };
}

/**
 * Confirm each allowlisted table exists and is readable, with `LIMIT 0` so the
 * check costs a plan and no rows.
 *
 * A table whose name is not a plain identifier is reported as unchecked rather
 * than quoted into the statement, the same rule `src/lib/catalog/identifiers.ts`
 * applies: the cost is one unverified row in this report, and the alternative
 * is interpolating a name from a database the operator may not control.
 */
async function checkTables(client: Client, source: SourceRecord): Promise<TestTable[]> {
  const results: TestTable[] = [];
  for (const [index, table] of source.config.tables.entries()) {
    if (!isPlainIdentifier(table.name)) {
      results.push({
        table: table.name,
        reachable: false,
        error: "not checked: the table name is not a plain SQL identifier",
      });
      continue;
    }
    const probe = await inSavepoint(client, `holo_table_${index}`, () =>
      client.query(`SELECT 1 FROM ${table.name} LIMIT 0`),
    );
    results.push(
      probe.ok
        ? { table: table.name, reachable: true }
        : { table: table.name, reachable: false, error: errorMessage(probe.error) },
    );
  }
  return results;
}
