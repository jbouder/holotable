import type { CatalogHealth } from "@/lib/catalog/health";
import { type ApiError, readApiError } from "@/lib/errors";
import {
  type CatalogColumn,
  type CatalogTable,
  type SourceConfig,
  type SourceRecord,
  sourceCatalog,
} from "@/lib/registry";

/**
 * The per-source catalog browser (#123): what it is sent, how it searches, and
 * the one edit it makes.
 *
 * The browser is open to every role that may use the source, but it does not
 * show every role the same catalog. A source admin sees every allowlisted
 * column with its `exposed` flag, because deciding that flag is the reason to
 * be there. Anyone else sees the projection the SQL editor already receives,
 * {@link sourceCatalog}, which omits unexposed columns. A hidden column's name
 * is part of what was hidden, so it does not reach a viewer's browser.
 */

export interface CatalogView {
  schema: string;
  /** Every column for a source admin, exposed columns only for anyone else. */
  tables: CatalogTable[];
  /** Allowlisted tables the last refresh could not find. */
  missingTables: string[];
  catalogHealth: CatalogHealth;
  /** The caller's `source:manage`, decided by `can()` on the server. */
  canManage: boolean;
}

/** Build the view for one caller. Server-side; `canManage` comes from `can()`. */
export function catalogView(
  source: Pick<SourceRecord, "config" | "catalogMissingTables">,
  catalogHealth: CatalogHealth,
  canManage: boolean,
): CatalogView {
  const projected = canManage ? source.config : sourceCatalog(source.config);
  return {
    schema: projected.schema,
    tables: projected.tables,
    missingTables: [...source.catalogMissingTables],
    catalogHealth,
    canManage,
  };
}

/** One table as the search leaves it. */
export interface CatalogMatch {
  table: CatalogTable;
  /** The columns to show: all of them when the table itself matched. */
  columns: CatalogColumn[];
  /** The table's own name or description matched the query. */
  tableMatched: boolean;
}

function contains(haystack: string | undefined, needle: string): boolean {
  return haystack?.toLowerCase().includes(needle) === true;
}

/**
 * Search tables and columns by name, type and description, case-insensitively.
 *
 * A table that matches keeps all its columns, so searching for a table shows
 * the whole table. Otherwise a table is kept with just its matching columns,
 * and a table with none is dropped. An empty query matches everything.
 */
export function searchCatalog(tables: CatalogTable[], query: string): CatalogMatch[] {
  const needle = query.trim().toLowerCase();
  const out: CatalogMatch[] = [];
  for (const table of tables) {
    if (
      needle === "" ||
      contains(table.name, needle) ||
      contains(table.description, needle)
    ) {
      out.push({ table, columns: table.columns, tableMatched: needle !== "" });
      continue;
    }
    const columns = table.columns.filter(
      (c) =>
        contains(c.name, needle) ||
        contains(c.type, needle) ||
        contains(c.description, needle),
    );
    if (columns.length > 0) out.push({ table, columns, tableMatched: false });
  }
  return out;
}

/**
 * The config with one column's exposure set, or null if the table or column is
 * not in the catalog.
 *
 * Exposing a column removes the flag rather than writing `exposed: true`.
 * Absent and `true` mean the same thing, so the stored config stays the shape
 * it had before the column was ever hidden.
 */
export function setColumnExposure(
  config: SourceConfig,
  table: string,
  column: string,
  exposed: boolean,
): SourceConfig | null {
  const target = config.tables.find((t) => t.name === table);
  if (!target?.columns.some((c) => c.name === column)) return null;
  return {
    ...config,
    tables: config.tables.map((t) =>
      t.name !== table
        ? t
        : {
            ...t,
            columns: t.columns.map((c) => {
              if (c.name !== column) return c;
              const { exposed: _, ...rest } = c;
              return exposed ? rest : { ...rest, exposed: false };
            }),
          },
    ),
  };
}

// --- Fetch helpers ---------------------------------------------------------------

export type CatalogViewResult =
  | { ok: true; view: CatalogView }
  | { ok: false; error: ApiError };

function catalogUrl(sourceId: string): string {
  return `/api/sources/${encodeURIComponent(sourceId)}/catalog`;
}

async function viewFrom(res: Response): Promise<CatalogViewResult> {
  if (!res.ok) return { ok: false, error: await readApiError(res) };
  return { ok: true, view: ((await res.json()) as { view: CatalogView }).view };
}

export async function fetchCatalogView(sourceId: string): Promise<CatalogViewResult> {
  return viewFrom(await fetch(catalogUrl(sourceId), { cache: "no-store" }));
}

/** Hide or expose one column. The answer is the catalog as it now stands. */
export async function updateColumnExposure(
  sourceId: string,
  change: { table: string; column: string; exposed: boolean },
): Promise<CatalogViewResult> {
  return viewFrom(
    await fetch(catalogUrl(sourceId), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(change),
    }),
  );
}
