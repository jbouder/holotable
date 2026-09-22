import { Client } from "pg";
import { fenceUntrustedBlock, sanitizePromptField } from "@/lib/ai/untrusted";
import { liveCatalogTables } from "@/lib/catalog/health";
import {
  resolveCredentials,
  CatalogColumn,
  CatalogTable,
  MAX_COLUMNS,
  MAX_TABLES,
  SourceConfig,
  type SourceConnection,
  type SourceRecord,
} from "@/lib/registry";

// The clamp for each catalog field in a prompt is the registry schema's own
// maximum, read from the schema so the two cannot drift apart.
const MAX = {
  sourceId: 128,
  sourceName: 200,
  database: SourceConfig.shape.database.maxLength ?? 128,
  schema: SourceConfig.shape.schema.unwrap().maxLength ?? 128,
  table: CatalogTable.shape.name.maxLength ?? 128,
  tableDescription: CatalogTable.shape.description.unwrap().maxLength ?? 500,
  timeField: CatalogTable.shape.timeField.unwrap().maxLength ?? 128,
  column: CatalogColumn.shape.name.maxLength ?? 128,
  columnType: CatalogColumn.shape.type.maxLength ?? 64,
  columnDescription: CatalogColumn.shape.description.unwrap().maxLength ?? 500,
} as const;

/**
 * The catalog as prompt lines, one table or column per line, every field
 * flattened and clamped by {@link sanitizePromptField}. Names and descriptions
 * come from a database the operator may not control, so no value here can span
 * a line or exceed its schema maximum. Callers fence the result with
 * {@link fenceUntrustedBlock}; use {@link buildCatalogPrompt} for the common
 * single-source case. Exported for testing.
 *
 * A table the last refresh could not find is omitted. Its columns are the last
 * ones it had, not the ones it has, and describing them to the model is how a
 * dropped table turns into confident SQL against a relation that is gone. It
 * stays in the allowlist — only the author edits that — so nothing here
 * widens what the guard permits.
 */
export function renderCatalog(source: SourceRecord): string {
  const f = sanitizePromptField;
  const lines: string[] = [];
  lines.push(
    `Source: ${f(source.name, MAX.sourceName)} (id: ${f(source.id, MAX.sourceId)}, kind: ${f(source.kind, 32)})`,
  );
  lines.push(`Database: ${f(source.config.database, MAX.database)}`);
  lines.push(`Schema: ${f(source.config.schema, MAX.schema)}`);
  lines.push("Tables (only these may be queried):");
  for (const table of liveCatalogTables(source)) {
    const description = table.description
      ? ` -- ${f(table.description, MAX.tableDescription)}`
      : "";
    lines.push(`- ${f(table.name, MAX.table)}${description}`);
    if (table.timeField)
      lines.push(`    time column: ${f(table.timeField, MAX.timeField)}`);
    for (const column of table.columns) {
      const description = column.description
        ? ` -- ${f(column.description, MAX.columnDescription)}`
        : "";
      lines.push(
        `    ${f(column.name, MAX.column)} ${f(column.type, MAX.columnType)}${description}`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * The catalog for one source as a fenced data block for a system prompt: a
 * standing instruction that the contents are data, then the sanitized catalog
 * between markers that carry a random per-call token.
 */
export function buildCatalogPrompt(source: SourceRecord): string {
  return fenceUntrustedBlock("CATALOG", renderCatalog(source));
}

/** A client for introspection only: no statement timeout, no query path. */
function catalogClient(connection: SourceConnection, secretRef: string): Client {
  const credentials = resolveCredentials(secretRef);
  return new Client({
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: credentials.username,
    password: credentials.password,
    ssl: connection.ssl,
    application_name: "holotable-catalog",
  });
}

/**
 * Every table in the schema the source's read-only user can see, with its
 * columns — the menu a source author picks an allowlist from.
 *
 * This is *not* an allowlist and never becomes one on its own: nothing here
 * reaches `SourceConfig` until the author selects a table and the create/update
 * route validates it. `information_schema` already scopes its rows to what the
 * connecting role has privileges on, and that role is the read-only one named
 * by `secret_ref`, so discovery can show no more than execution could read.
 */
export async function discoverTables(
  connection: SourceConnection,
  secretRef: string,
): Promise<CatalogTable[]> {
  const client = catalogClient(connection, secretRef);
  await client.connect();
  try {
    const result = await client.query<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(
      `SELECT c.table_name, c.column_name, c.data_type
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_catalog = c.table_catalog
          AND t.table_schema = c.table_schema
          AND t.table_name = c.table_name
        WHERE c.table_catalog = $1
          AND c.table_schema = $2
          AND t.table_type IN ('BASE TABLE', 'VIEW')
        ORDER BY c.table_name, c.ordinal_position`,
      [connection.database, connection.schema],
    );

    const byTable = new Map<string, CatalogColumn[]>();
    for (const row of result.rows) {
      const columns = byTable.get(row.table_name) ?? [];
      if (columns.length === 0) {
        if (byTable.size >= MAX_TABLES) continue;
        byTable.set(row.table_name, columns);
      }
      if (columns.length >= MAX_COLUMNS) continue;
      columns.push({ name: row.column_name, type: row.data_type });
    }

    return [...byTable].map(([name, columns]) => ({ name, columns }));
  } finally {
    await client.end();
  }
}

/** What a refresh found: the re-read catalog, and what it could not find. */
export interface CatalogRefresh {
  config: SourceConfig;
  /**
   * Allowlisted tables `information_schema` returned no column for — dropped,
   * renamed, or no longer readable by the source's read-only role.
   */
  missingTables: string[];
}

/**
 * Refresh column metadata for the existing table allowlist. This never expands
 * the set of tables available to generated SQL, and it never shrinks it
 * either: the allowlist is its author's, and a table that has gone missing is
 * *reported* rather than dropped, because a revoked grant and a dropped table
 * look identical from here and only one of them should cost the author their
 * configuration.
 *
 * A missing table keeps its last known columns in the stored config so the
 * author can still see what it was, but it is recorded in `missingTables`,
 * which is what makes the source read `drifted` and what keeps those columns
 * out of the prompt (see {@link renderCatalog}).
 */
export async function refreshCatalog(source: SourceRecord): Promise<CatalogRefresh> {
  const client = catalogClient(source.config, source.secretRef);

  await client.connect();
  try {
    const tables: CatalogTable[] = [];
    const missingTables: string[] = [];
    for (const existing of source.config.tables) {
      const result = await client.query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type
           FROM information_schema.columns
          WHERE table_catalog = $1 AND table_schema = $2 AND table_name = $3
          ORDER BY ordinal_position`,
        [source.config.database, source.config.schema, existing.name],
      );
      if (result.rows.length === 0) missingTables.push(existing.name);
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
    return { config: SourceConfig.parse({ ...source.config, tables }), missingTables };
  } finally {
    await client.end();
  }
}
