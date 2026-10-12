import { fenceUntrustedBlock, sanitizePromptField } from "@/lib/ai/untrusted";
import { exposedCatalogTables } from "@/lib/catalog/health";
import { refreshedColumns } from "@/lib/catalog/introspection";
import { CatalogColumn, CatalogTable } from "@/lib/registry";
import { introspect } from "@/lib/duckdb/client";
import {
  DUCKDB_SCHEMA,
  DuckDbConfig,
  type DuckDbFacts,
  type DuckDbSourceRecord,
  duckdbLayout,
} from "@/lib/sources/kinds/duckdb";

// The clamp for each catalog field in a prompt is the registry schema's own
// maximum, read from the schema so the two cannot drift apart.
const MAX = {
  sourceId: 128,
  sourceName: 200,
  table: CatalogTable.shape.name.maxLength ?? 128,
  tableDescription: CatalogTable.shape.description.unwrap().maxLength ?? 500,
  timeField: CatalogTable.shape.timeField.unwrap().maxLength ?? 128,
  column: CatalogColumn.shape.name.maxLength ?? 128,
  columnType: CatalogColumn.shape.type.maxLength ?? 64,
  columnDescription: CatalogColumn.shape.description.unwrap().maxLength ?? 500,
} as const;

/**
 * A DuckDB source's catalog as prompt lines, the way the TimescaleDB kind
 * renders its own: every field flattened and clamped, missing tables and
 * unexposed columns left out. The path is never part of it; a directory's
 * tables are named by their files' stems, which is all the model needs.
 */
export function renderDuckDbCatalog(source: DuckDbSourceRecord): string {
  const f = sanitizePromptField;
  const layout = duckdbLayout(source.config.path);
  const lines: string[] = [
    `Source: ${f(source.name, MAX.sourceName)} (id: ${f(source.id, MAX.sourceId)}, kind: duckdb)`,
    layout === "directory"
      ? "Engine: DuckDB, over a directory of files (each table is one Parquet or CSV file)"
      : "Engine: DuckDB, over a database file",
    `Schema: ${DUCKDB_SCHEMA}`,
    "Tables (only these may be queried):",
  ];
  for (const table of exposedCatalogTables(source)) {
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
 * Said after a DuckDB source's catalog: fixed text, outside the fence. The
 * guard's grammar is PostgreSQL's, which DuckDB's parser shares; these are
 * the functions that bucket time on both.
 */
export const DUCKDB_PROMPT =
  "This source is DuckDB, queried with the same SELECT-only SQL as PostgreSQL. " +
  "Bucket time with `time_bucket(INTERVAL '5 minutes', ts)`, `date_trunc('minute', ts)` " +
  "or `date_bin(INTERVAL '5 minutes', ts, TIMESTAMP '2000-01-01')`. Table functions " +
  "such as `read_parquet` or `read_csv` are refused: query the tables listed.";

/** The catalog block of the generation prompt, fenced as untrusted data. */
export function buildDuckDbCatalogPrompt(source: DuckDbSourceRecord): string {
  return `${fenceUntrustedBlock("CATALOG", renderDuckDbCatalog(source))}\n\n${DUCKDB_PROMPT}`;
}

/** What a DuckDB refresh found, in the shape every SQL kind's refresh has. */
export interface DuckDbCatalogRefresh {
  config: DuckDbConfig;
  missingTables: string[];
  facts: DuckDbFacts;
}

/**
 * Re-read the allowlisted tables' columns from a freshly opened engine: a
 * directory is listed again (a file gone is a table missing), a database's
 * `information_schema` is read. Like every refresh it never adds a table to
 * the allowlist and never drops one: a missing table keeps its last known
 * columns and is reported.
 */
export async function refreshDuckDbCatalog(
  source: DuckDbSourceRecord,
): Promise<DuckDbCatalogRefresh> {
  const found = await introspect(source);
  const byName = new Map(found.tables.map((t) => [t.name, t.columns]));
  const tables: CatalogTable[] = [];
  const missingTables: string[] = [];
  for (const existing of source.config.tables) {
    const rows = byName.get(existing.name) ?? [];
    if (rows.length === 0) missingTables.push(existing.name);
    tables.push({
      name: existing.name,
      description: existing.description,
      timeField: existing.timeField,
      columns:
        rows.length > 0 ? refreshedColumns(existing.columns, rows) : existing.columns,
    });
  }
  return {
    config: DuckDbConfig.parse({ ...source.config, tables }),
    missingTables,
    facts: { duckdb: found.version },
  };
}
