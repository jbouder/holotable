import { isPlainIdentifier, timeColumn } from "@/lib/catalog/identifiers";
import type { Panel, PanelLayout, VizType } from "@/lib/ir";
import type { CatalogTable, SourceCatalog } from "@/lib/registry";

/**
 * What a brand-new panel starts from.
 *
 * `addPanel` used to create `SELECT 1 AS value` as a line chart. That
 * validates and executes, so the editor looked like it worked, but it draws a
 * flat line of a constant — the author's first act after adding a panel was
 * always to delete the placeholder. The catalog needed to do better is already
 * in the editor for completion (#109), so the starter is built from it.
 *
 * The same three constraints as `src/lib/builtin-templates.ts` apply, for the
 * same reasons: no time filter in the SQL (the server injects it on the column
 * named by `timeField` — invariant 4), plain identifiers only
 * (`src/lib/catalog/identifiers.ts`), and `date_trunc` rather than
 * `time_bucket` so the starter also works against plain PostgreSQL.
 *
 * Because every name here comes from the source's own allowlist, the result is
 * guaranteed to pass `validateSql` against that source — `test/panel-starter.test.ts`
 * asserts that through the real guard rather than assuming it.
 */

/**
 * The starter of last resort: a source with no usable table still has to
 * produce a panel that parses, because the IR requires one.
 */
export const PLACEHOLDER_SQL = "SELECT 1 AS value";

export interface PanelStarter {
  sql: string;
  /** The output column the server filters time on, when there is one. */
  timeField?: string;
  viz: VizType;
  /** A title that says what the query does, not "New panel". */
  title: string;
}

const PLACEHOLDER: PanelStarter = {
  sql: PLACEHOLDER_SQL,
  viz: "line",
  title: "New panel",
};

/** A table this module is willing to name in generated SQL. */
function usable(table: CatalogTable): boolean {
  return isPlainIdentifier(table.name) && table.columns.length > 0;
}

/**
 * The query a new panel on this source opens with.
 *
 * A table with a time column gets a per-minute count — the one question every
 * monitoring table can answer, and a time series so the dashboard's window
 * means something. A source whose tables have no time column gets a plain
 * count as a stat, which is honest about what the schema supports rather than
 * drawing an empty chart.
 */
export function panelStarter(
  catalog: Pick<SourceCatalog, "tables"> | null,
): PanelStarter {
  const tables = (catalog?.tables ?? []).filter(usable);

  for (const table of tables) {
    const time = timeColumn(table);
    if (!time) continue;
    return {
      sql: `SELECT date_trunc('minute', ${time}) AS bucket, count(*) AS value\nFROM ${table.name}\nGROUP BY bucket\nORDER BY bucket`,
      timeField: "bucket",
      viz: "line",
      title: `${table.name} per minute`,
    };
  }

  const first = tables[0];
  if (first) {
    return {
      sql: `SELECT count(*) AS value\nFROM ${first.name}`,
      viz: "stat",
      title: `${first.name} rows`,
    };
  }

  return PLACEHOLDER;
}

/** Build the whole panel, ready for the spec. */
export function starterPanel(
  id: string,
  sourceId: string,
  catalog: Pick<SourceCatalog, "tables"> | null,
  layout: PanelLayout,
): Panel {
  const starter = panelStarter(catalog);
  return {
    id,
    title: starter.title,
    viz: starter.viz,
    query: { sourceId, sql: starter.sql, timeField: starter.timeField },
    layout,
  };
}

function normalize(sql: string): string {
  return sql.trim().replace(/\s+/g, " ");
}

/**
 * Is this panel still the query the editor wrote for it?
 *
 * Deleting a panel is undoable (#81), so a confirmation everywhere would be
 * noise. It is worth one only when there is work to lose, and "the SQL is
 * still exactly what was generated for it" is the one form of that question
 * this module can answer without guessing.
 */
export function isStarterSql(
  sql: string,
  catalog: Pick<SourceCatalog, "tables"> | null,
): boolean {
  const seen = normalize(sql);
  return (
    seen === normalize(PLACEHOLDER_SQL) || seen === normalize(panelStarter(catalog).sql)
  );
}
