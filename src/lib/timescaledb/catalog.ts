import { Client } from "pg";
import {
  resolveCredentials,
  SourceConfig,
  type CatalogTable,
  type SourceRecord,
} from "@/lib/registry";

export function buildCatalogPrompt(source: SourceRecord): string {
  const lines: string[] = [];
  lines.push(`Source: ${source.name} (id: ${source.id}, kind: ${source.kind})`);
  lines.push(`Database: ${source.config.database}`);
  lines.push(`Schema: ${source.config.schema}`);
  lines.push("Tables (only these may be queried):");
  for (const table of source.config.tables) {
    const description = table.description ? ` -- ${table.description}` : "";
    lines.push(`- ${table.name}${description}`);
    if (table.timeField) lines.push(`    time column: ${table.timeField}`);
    for (const column of table.columns) {
      const description = column.description ? ` -- ${column.description}` : "";
      lines.push(`    ${column.name} ${column.type}${description}`);
    }
  }
  return lines.join("\n");
}

/**
 * Refresh column metadata for the existing table allowlist. This never expands
 * the set of tables available to generated SQL.
 */
export async function refreshCatalog(source: SourceRecord): Promise<SourceConfig> {
  const credentials = resolveCredentials(source.secretRef);
  const client = new Client({
    host: source.config.host,
    port: source.config.port,
    database: source.config.database,
    user: credentials.username,
    password: credentials.password,
    ssl: source.config.ssl,
    application_name: "holotable-catalog",
  });

  await client.connect();
  try {
    const tables: CatalogTable[] = [];
    for (const existing of source.config.tables) {
      const result = await client.query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type
           FROM information_schema.columns
          WHERE table_catalog = $1 AND table_schema = $2 AND table_name = $3
          ORDER BY ordinal_position`,
        [source.config.database, source.config.schema, existing.name],
      );
      tables.push({
        name: existing.name,
        description: existing.description,
        timeField: existing.timeField,
        columns:
          result.rows.length > 0
            ? result.rows.map((column) => ({
                name: column.column_name,
                type: column.data_type,
              }))
            : existing.columns,
      });
    }
    return SourceConfig.parse({ ...source.config, tables });
  } finally {
    await client.end();
  }
}
