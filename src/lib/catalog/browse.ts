import { timescaledb } from "@/lib/sources/kinds/timescaledb";
import { z } from "zod";
import type { CatalogHealth } from "@/lib/catalog/health";
import { type ApiError, apiErrorFromThrown, readApiError } from "@/lib/errors";
import {
  type CatalogColumn,
  type CatalogTable,
  type SqlSourceConfig,
  type SqlSourceRecord,
  sourceCatalog,
} from "@/lib/registry";
import { ImpactDashboard, impactCounts } from "@/lib/source-impact";

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

/**
 * A Prometheus source's catalog (#386): its allowlisted metrics with their
 * type, help and labels. The same for every caller — there is no label to
 * hide — and never the URL or the auth mode.
 */
export interface MetricCatalogView {
  metrics: { name: string; type: string; help?: string; labels: string[] }[];
  /** Allowlisted metrics the last refresh found no series for. */
  missingMetrics: string[];
  catalogHealth: CatalogHealth;
  canManage: boolean;
}

export type AnyCatalogView = CatalogView | MetricCatalogView;

export function isMetricCatalogView(view: AnyCatalogView): view is MetricCatalogView {
  return "metrics" in view;
}

/** Build the view for one caller. Server-side; `canManage` comes from `can()`. */
export function catalogView(
  source: Pick<SqlSourceRecord, "config" | "catalogMissingTables">,
  catalogHealth: CatalogHealth,
  canManage: boolean,
): CatalogView {
  const projected = canManage ? source.config : timescaledb.catalog(source.config);
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
  config: SqlSourceConfig,
  table: string,
  column: string,
  exposed: boolean,
): SqlSourceConfig | null {
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

export type AnyCatalogViewResult =
  | { ok: true; view: AnyCatalogView }
  | { ok: false; error: ApiError };

/** A source's catalog as this caller may see it: tables for SQL, metrics for PromQL. */
export async function fetchCatalogView(sourceId: string): Promise<AnyCatalogViewResult> {
  const res = await fetch(catalogUrl(sourceId), { cache: "no-store" });
  if (!res.ok) return { ok: false, error: await readApiError(res) };
  return { ok: true, view: ((await res.json()) as { view: AnyCatalogView }).view };
}

/** The metrics whose name, type, help or a label contains the query. */
export function searchMetrics(
  metrics: MetricCatalogView["metrics"],
  query: string,
): MetricCatalogView["metrics"] {
  const q = query.trim().toLowerCase();
  if (q === "") return metrics;
  return metrics.filter(
    (m) =>
      m.name.toLowerCase().includes(q) ||
      m.type.toLowerCase().includes(q) ||
      (m.help ?? "").toLowerCase().includes(q) ||
      m.labels.some((l) => l.toLowerCase().includes(q)),
  );
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

// --- Hiding a column that panels read (#267) --------------------------------------

/**
 * What hiding one column would break: the current panels the guard would
 * start refusing. Ids and titles only, the same shape as a source's impact
 * (#125). Never a panel's SQL.
 */
export const ColumnImpact = z
  .object({
    table: z.string(),
    column: z.string(),
    dashboards: z.array(ImpactDashboard),
  })
  .strict();
export type ColumnImpact = z.infer<typeof ColumnImpact>;

/** The warning shown before hiding, or null when nothing would break. */
export function describeHideImpact(impact: ColumnImpact): string | null {
  const counts = impactCounts({
    sourceId: "",
    dashboards: impact.dashboards,
    referencedByAnyVersion: false,
  });
  if (counts.panels === 0) return null;
  const panels = `${counts.panels} panel${counts.panels === 1 ? "" : "s"}`;
  const dashboards = `${counts.dashboards} dashboard${counts.dashboards === 1 ? "" : "s"}`;
  return `Hiding ${impact.table}.${impact.column} will break ${panels} across ${dashboards}: their SQL reads it, and the guard will refuse it until they are changed.`;
}

export type ColumnImpactResult =
  | { ok: true; impact: ColumnImpact }
  | { ok: false; error: ApiError };

export async function fetchHideImpact(
  sourceId: string,
  table: string,
  column: string,
): Promise<ColumnImpactResult> {
  const params = new URLSearchParams({ table, column });
  try {
    const res = await fetch(`${catalogUrl(sourceId)}/impact?${params}`, {
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, error: await readApiError(res) };
    const body: unknown = await res.json();
    const parsed = ColumnImpact.safeParse(
      (body as { impact?: unknown } | null)?.impact ?? null,
    );
    return parsed.success
      ? { ok: true, impact: parsed.data }
      : {
          ok: false,
          error: { error: "the impact result was malformed", kind: "unknown" },
        };
  } catch (err) {
    return { ok: false, error: apiErrorFromThrown(err) };
  }
}
