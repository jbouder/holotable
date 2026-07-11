import { createClient } from "@clickhouse/client";
import {
  resolveCredentials,
  SourceConfig,
  type CatalogTable,
  type SourceRecord,
} from "@/lib/registry";

/**
 * Catalog helpers.
 *
 * The catalog is METADATA ONLY (table names, column names/types, descriptions).
 * It is what the LLM sees. No data rows are ever included in a prompt, and only
 * a single, already-authorized source's catalog is provided per generation.
 */

export function buildCatalogPrompt(source: SourceRecord): string {
  const lines: string[] = [];
  lines.push(`Source: ${source.name} (id: ${source.id}, kind: ${source.kind})`);
  lines.push(`Database: ${source.config.database}`);
  lines.push("Tables (only these may be queried):");
  for (const t of source.config.tables) {
    const desc = t.description ? ` -- ${t.description}` : "";
    lines.push(`- ${t.name}${desc}`);
    if (t.timeField) lines.push(`    time column: ${t.timeField}`);
    for (const c of t.columns) {
      const cd = c.description ? ` -- ${c.description}` : "";
      lines.push(`    ${c.name} ${c.type}${cd}`);
    }
  }
  return lines.join("\n");
}

/**
 * Refresh a source's catalog by introspecting ClickHouse `system.columns` for
 * each allowlisted table. The set of allowed tables is NOT expanded here; only
 * the column metadata is refreshed for the existing allowlist.
 */
export async function refreshCatalog(source: SourceRecord): Promise<SourceConfig> {
  const creds = resolveCredentials(source.secretRef);
  const { protocol, host, port, database } = source.config;
  const client = createClient({
    url: `${protocol}://${host}:${port}`,
    username: creds.username,
    password: creds.password,
    database,
    clickhouse_settings: { readonly: "1" },
  });

  try {
    const tables: CatalogTable[] = [];
    for (const existing of source.config.tables) {
      const rs = await client.query({
        query: `SELECT name, type FROM system.columns
                WHERE database = {db:String} AND table = {tbl:String}
                ORDER BY position`,
        query_params: { db: database, tbl: existing.name },
        format: "JSONEachRow",
      });
      const cols = (await rs.json()) as { name: string; type: string }[];
      tables.push({
        name: existing.name,
        description: existing.description,
        timeField: existing.timeField,
        columns:
          cols.length > 0
            ? cols.map((c) => ({ name: c.name, type: c.type }))
            : existing.columns,
      });
    }
    return SourceConfig.parse({ ...source.config, tables });
  } finally {
    await client.close();
  }
}
