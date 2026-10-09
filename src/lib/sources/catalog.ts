import { z } from "zod";
import { CLAIM_NAME } from "@/lib/auth/claims";

/**
 * The catalog shapes every source kind shares: a table allowlist with its
 * columns, the row-filter predicate, and the projections that decide which of
 * it may be described to the model or the editor.
 *
 * They live apart from `@/lib/registry` so a kind module
 * (`src/lib/sources/kinds/`) can build its config schema from them while the
 * registry builds the {@link SourceConfig} union from the kinds, with no
 * import cycle between the two. `@/lib/registry` re-exports every name here,
 * so callers keep importing from there.
 */

/**
 * The allowlist caps, named because discovery has to honor them too: the menu
 * a source author picks from can never be allowed to exceed what a valid
 * `SourceConfig` could hold.
 */
export const MAX_TABLES = 200;
export const MAX_COLUMNS = 200;

export const CatalogColumn = z
  .object({
    name: z.string().min(1).max(128),
    type: z.string().min(1).max(64),
    description: z.string().max(500).optional(),
    /**
     * Whether generated SQL may reference this column and the model may be
     * told it exists. Absent means exposed, so every config stored before the
     * flag existed reads exactly as it did. `false` keeps the column out of
     * the prompt and the editor, and `validateSql` refuses any statement that
     * names it, selects `*` over its table, or reads its table's whole row.
     */
    exposed: z.boolean().optional(),
  })
  .strict();
export type CatalogColumn = z.infer<typeof CatalogColumn>;

export const CatalogTable = z
  .object({
    name: z.string().min(1).max(128),
    description: z.string().max(500).optional(),
    /** Preferred time column for server-injected time filtering. */
    timeField: z.string().min(1).max(128).optional(),
    columns: z.array(CatalogColumn).min(1).max(MAX_COLUMNS),
  })
  .strict();
export type CatalogTable = z.infer<typeof CatalogTable>;

/**
 * A mandatory tenant predicate (#31): every table this source reads is
 * narrowed to the rows whose `column` equals the viewer's `claim`, before any
 * statement sees them. `column` is a bare identifier, checked exactly as a
 * `timeField` is, and must be a column of every table in the catalog.
 * `claim` is `sub` or a name listed in `ROW_FILTER_CLAIMS`; the value always
 * comes from the verified identity, never from a request or the model.
 */
export const RowFilter = z
  .object({
    column: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be a bare column name")
      .max(63),
    claim: z.string().regex(CLAIM_NAME, "must be a claim name"),
  })
  .strict();
export type RowFilter = z.infer<typeof RowFilter>;

/**
 * The part of a source that may be sent to a browser: the schema name and the
 * table allowlist with its columns, and nothing else.
 *
 * The editor needs the catalog to complete table and column names and to warn
 * about a table the guard will refuse. It does not need — and invariant 5 says
 * it must not receive — the host, port, database, TLS setting or `secret_ref`
 * that sit beside the catalog in a source's config. Each kind projects its
 * config into this shape by naming the fields (`catalog` in its kind module)
 * rather than spreading the config, which is what keeps a field added to a
 * config later from reaching the client by default.
 */
export interface SourceCatalog {
  schema: string;
  tables: CatalogTable[];
}

/**
 * The set of allowed table names for a source, bare and schema-qualified,
 * exactly as the catalog spells them.
 *
 * Names are compared character for character, never case-folded. PostgreSQL
 * folds an *unquoted* identifier to lowercase and preserves the case of a
 * *quoted* one, so `"HTTP_REQUESTS"` is a different relation from
 * `http_requests`. The parser applies the same folding before the guard sees
 * a name, so an exact comparison here is exactly the server's resolution;
 * lowercasing on either side would collapse the two into one.
 */
export function allowedTables(cfg: SourceCatalog): Set<string> {
  const set = new Set<string>();
  for (const t of cfg.tables) {
    set.add(t.name);
    set.add(`${cfg.schema}.${t.name}`);
  }
  return set;
}

/** A column is exposed unless its author said otherwise. */
export function isExposed(column: CatalogColumn): boolean {
  return column.exposed !== false;
}

/** The columns of a table that generated SQL may reference. */
export function exposedColumns(table: CatalogTable): CatalogColumn[] {
  return table.columns.filter(isExposed);
}

/** The names of a table's unexposed columns, exactly as the catalog spells them. */
export function unexposedColumns(table: CatalogTable): Set<string> {
  return new Set(table.columns.filter((c) => !isExposed(c)).map((c) => c.name));
}

/**
 * A table as it may be described — to the model, to the editor, or to a
 * catalog-derived suggestion: its exposed columns only, and no `timeField`
 * when that column is unexposed, since a query could not select it.
 *
 * The result is a view, not a valid `CatalogTable`: a table whose every
 * column is unexposed comes back with none. It must never be stored.
 */
export function exposedTable(table: CatalogTable): CatalogTable {
  const hidden = unexposedColumns(table);
  if (hidden.size === 0) return table;
  const { timeField, ...rest } = table;
  return {
    ...rest,
    ...(timeField && !hidden.has(timeField) ? { timeField } : {}),
    columns: exposedColumns(table),
  };
}
