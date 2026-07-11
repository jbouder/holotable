import { createClient, type ClickHouseClient } from "@clickhouse/client";
import {
  resolveCredentials,
  type SourceRecord,
} from "@/lib/registry";
import { config } from "@/lib/config";
import type { ExecutablePlan } from "@/lib/sql/safety";

/**
 * ClickHouse access for the metrics store.
 *
 * Clients are created per (source, credentials) using the read-only user
 * resolved from the source's secret_ref. Execution never uses a privileged
 * user, and read-only settings are enforced on every query.
 */

function clientFor(source: SourceRecord): ClickHouseClient {
  const creds = resolveCredentials(source.secretRef);
  const { protocol, host, port, database } = source.config;
  return createClient({
    url: `${protocol}://${host}:${port}`,
    username: creds.username,
    password: creds.password,
    database,
    request_timeout: (config.queryTimeoutSeconds + 5) * 1000,
    clickhouse_settings: {
      // Defensive defaults; per-query settings are also applied.
      readonly: "1",
    },
  });
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

/** Execute a guarded {@link ExecutablePlan} and return JSON rows. */
export async function executePlan(
  source: SourceRecord,
  plan: ExecutablePlan,
): Promise<QueryResult> {
  const client = clientFor(source);
  try {
    const rs = await client.query({
      query: plan.sql,
      query_params: plan.params,
      clickhouse_settings: plan.settings as Record<string, string>,
      format: "JSONEachRow",
    });
    const rows = (await rs.json()) as Record<string, unknown>[];
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    return { columns, rows };
  } finally {
    await client.close();
  }
}

/** Lightweight connectivity/permission test for a source. */
export async function testSource(source: SourceRecord): Promise<{ ok: boolean; message: string }> {
  const client = clientFor(source);
  try {
    const rs = await client.query({ query: "SELECT 1 AS ok", format: "JSONEachRow" });
    await rs.json();
    return { ok: true, message: "connection succeeded" };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  } finally {
    await client.close();
  }
}
