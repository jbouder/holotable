import { Client } from "pg";
import { resolveCredentials, type SourceRecord } from "@/lib/registry";
import { config } from "@/lib/config";
import type { ExecutablePlan } from "@/lib/sql/safety";

function clientFor(source: SourceRecord): Client {
  const credentials = resolveCredentials(source.secretRef);
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
function isPostgresStatementError(err: unknown): err is { code: string; message: string } {
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

/** Execute a guarded plan in a read-only transaction. */
export async function executePlan(
  source: SourceRecord,
  plan: ExecutablePlan,
): Promise<QueryResult> {
  const client = clientFor(source);
  let transactionStarted = false;
  try {
    await client.connect();
    await client.query("BEGIN TRANSACTION READ ONLY");
    transactionStarted = true;
    await client.query(searchPathStatement(source.config.schema));
    const result = await client.query(plan.sql, plan.params);
    const rows = result.rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          value instanceof Date ? value.toISOString() : value,
        ]),
      ),
    );
    return {
      columns: result.fields.map((field) => field.name),
      rows,
    };
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

/** Lightweight connectivity and read-permission test for a source. */
export async function testSource(
  source: SourceRecord,
): Promise<{ ok: boolean; message: string }> {
  const client = clientFor(source);
  try {
    await client.connect();
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SELECT 1 AS ok");
    await client.query("ROLLBACK");
    return { ok: true, message: "connection succeeded" };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}
