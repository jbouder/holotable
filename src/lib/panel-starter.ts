import { isPlainIdentifier, timeColumn } from "@/lib/catalog/identifiers";
import {
  isSqlQuery,
  type Panel,
  type PanelLayout,
  type PanelQuery,
  type VizType,
} from "@/lib/ir";
import type { CatalogTable, SourceCatalog } from "@/lib/registry";
import type { PrometheusCatalog } from "@/lib/sources/kinds/prometheus";

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

/* ------------------------------------------------------------------------- */
/* PromQL (#388)                                                              */
/* ------------------------------------------------------------------------- */

/** The catalog of a source of either kind, as the editor holds it. */
export type StarterCatalog = Pick<SourceCatalog, "tables"> | PrometheusCatalog | null;

function isPrometheusCatalog(catalog: StarterCatalog): catalog is PrometheusCatalog {
  return catalog !== null && "metrics" in catalog;
}

export interface PromqlStarter {
  promql: string;
  instant?: true;
  viz: VizType;
  title: string;
}

/** The kinds that draw one value per series rather than a line over time. */
const INSTANT_KINDS: ReadonlySet<VizType> = new Set(["stat", "gauge", "table", "pie"]);

/** A metric name the starter can write bare: the guard's own name rule. */
const PLAIN_METRIC = /^[A-Za-z_:][A-Za-z0-9_:]*$/;

/** When the allowlist offers nothing: a constant, which the guard accepts. */
export const PLACEHOLDER_PROMQL = "vector(1)";

/**
 * The expression a new PromQL panel starts from: a counter's rate, a
 * histogram's p95, a gauge's sum, or a count of any listed metric's series,
 * in that order of preference. Every name is from the source's allowlist and
 * the range is the server's, so the starter carries no time of its own.
 */
function promqlExpression(catalog: PrometheusCatalog): { promql: string; title: string } {
  const metrics = catalog.metrics.filter((m) => PLAIN_METRIC.test(m.name));
  const counter = metrics.find((m) => m.type === "counter");
  if (counter) {
    return {
      promql: `sum(rate(${counter.name}[5m]))`,
      title: `${counter.name} per second`,
    };
  }
  const bucket = metrics.find(
    (m) => m.type === "histogram" && m.name.endsWith("_bucket"),
  );
  if (bucket) {
    return {
      promql: `histogram_quantile(0.95, sum by (le) (rate(${bucket.name}[5m])))`,
      title: `p95 ${bucket.name.slice(0, -"_bucket".length)}`,
    };
  }
  const gauge = metrics.find((m) => m.type === "gauge");
  if (gauge) return { promql: `sum(${gauge.name})`, title: gauge.name };
  const any = metrics[0];
  if (any) return { promql: `count(${any.name})`, title: `${any.name} series` };
  return { promql: PLACEHOLDER_PROMQL, title: "New panel" };
}

/**
 * A PromQL starter for a panel kind: the same expression, as an instant query
 * for a kind that draws one value per series (a stat, a gauge, a table, a
 * pie) and a range query for the rest. A new panel is a line.
 */
export function promqlStarter(
  catalog: PrometheusCatalog,
  viz: VizType = "line",
): PromqlStarter {
  const { promql, title } = promqlExpression(catalog);
  const instant = INSTANT_KINDS.has(viz);
  return { promql, viz, title, ...(instant ? { instant: true as const } : {}) };
}

/**
 * The query a panel starts from on a source, in that source's language: the
 * one place a new panel, a kind switched back to a query, and a panel moved
 * to a source of the other kind get their query.
 */
export function starterQuery(
  sourceId: string,
  catalog: StarterCatalog,
  viz?: VizType,
): { query: PanelQuery; title: string; viz: VizType } {
  if (isPrometheusCatalog(catalog)) {
    const starter = promqlStarter(catalog, viz);
    return {
      query: {
        sourceId,
        promql: starter.promql,
        ...(starter.instant ? { instant: true } : {}),
      },
      title: starter.title,
      viz: starter.viz,
    };
  }
  const starter = panelStarter(catalog);
  return {
    query: { sourceId, sql: starter.sql, timeField: starter.timeField },
    title: starter.title,
    viz: viz ?? starter.viz,
  };
}

/** Build the whole panel, ready for the spec. */
export function starterPanel(
  id: string,
  sourceId: string,
  catalog: StarterCatalog,
  layout: PanelLayout,
): Panel {
  const starter = starterQuery(sourceId, catalog);
  return { id, title: starter.title, viz: starter.viz, query: starter.query, layout };
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

/** `isStarterSql` for a query of either language. */
export function isStarterQuery(query: PanelQuery, catalog: StarterCatalog): boolean {
  if (isSqlQuery(query)) {
    return isStarterSql(query.sql, isPrometheusCatalog(catalog) ? null : catalog);
  }
  const seen = normalize(query.promql);
  return (
    seen === PLACEHOLDER_PROMQL ||
    (isPrometheusCatalog(catalog) && seen === normalize(promqlExpression(catalog).promql))
  );
}
