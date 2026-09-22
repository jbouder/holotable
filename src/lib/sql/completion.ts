import type { SourceCatalog } from "@/lib/registry";

/**
 * The catalog, shaped as the completion namespace the SQL editor wants.
 *
 * Structural on purpose: the fields are the ones CodeMirror's `Completion`
 * defines, but nothing here imports CodeMirror, so the mapping can be tested
 * as a function and the editor chunk stays the only thing that pulls the
 * editor in. `type` is one of CodeMirror's completion kinds — the icon shown
 * beside the name — and `detail` is the grey text after it.
 */
export interface CompletionEntry {
  label: string;
  type: "type" | "property";
  detail?: string;
}

export interface TableCompletions {
  self: CompletionEntry;
  children: CompletionEntry[];
}

export interface CatalogCompletions {
  /** Keyed by schema, then by table, exactly as a qualified name is written. */
  schema: Record<string, Record<string, TableCompletions>>;
  /** The schema whose tables also complete unqualified. */
  defaultSchema: string;
}

/**
 * Completions for one source. Only the allowlisted tables appear, which is the
 * point: what completes is what the guard will accept, so an author who takes
 * the suggestion cannot be refused for naming a table that is not in the
 * catalog.
 */
export function catalogCompletions(catalog: SourceCatalog): CatalogCompletions {
  const tables: Record<string, TableCompletions> = {};
  for (const table of catalog.tables) {
    tables[table.name] = {
      self: { label: table.name, type: "type", detail: table.description },
      children: table.columns.map((column) => ({
        label: column.name,
        type: "property",
        // The type is what an author is looking for when choosing a column,
        // and the description is usually a sentence — type first.
        detail: column.description
          ? `${column.type} — ${column.description}`
          : column.type,
      })),
    };
  }
  return { schema: { [catalog.schema]: tables }, defaultSchema: catalog.schema };
}
