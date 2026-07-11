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
