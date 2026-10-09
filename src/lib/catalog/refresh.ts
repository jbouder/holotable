import type { CatalogHealth, CatalogSubject } from "@/lib/catalog/health";
import { type ApiError, apiErrorFrom, readApiError } from "@/lib/errors";
import { type CatalogColumn, isExposed, type SqlSourceConfig } from "@/lib/registry";

/**
 * What a catalog refresh would change, shown before it is written (#123).
 *
 * A refresh used to write whatever it found and report "catalog refreshed"
 * either way. Now it runs in two steps against the same route: a *preview*
 * introspects the database and answers with this diff and a digest of what it
 * would store, and an *apply* sends the digest back. The server introspects
 * again and writes only if the result still matches the digest. So nothing is
 * written that the author has not seen, and the browser never sends a catalog
 * for the server to trust.
 *
 * This module is the diff (pure, shared by the route and the dialog), its
 * wording, and the fetch helpers. The digest is server-only, in
 * `src/lib/timescaledb/catalog.ts`.
 */

/** A column whose type the database now reports differently. */
export interface RetypedColumn {
  name: string;
  from: string;
  to: string;
}

/** The column-level changes to one allowlisted table. */
export interface TableChange {
  table: string;
  /** In the database, not in the stored catalog. A new column starts exposed. */
  added: CatalogColumn[];
  /**
   * In the stored catalog, gone from the database. Each keeps its `exposed`
   * flag, because a hidden column that is dropped and later re-added comes
   * back exposed, and the review says so.
   */
  removed: CatalogColumn[];
  retyped: RetypedColumn[];
}

export interface CatalogDiff {
  /**
   * Allowlisted tables the database did not return. An error, not a change: the
   * table stays in the allowlist (only its author edits that) and keeps its
   * last known columns, and the source reads `drifted` until it is back.
   */
  missingTables: string[];
  /** Tables the last refresh could not find, and this one did. */
  restoredTables: string[];
  /** Tables whose columns changed. Unchanged tables are not listed. */
  tables: TableChange[];
}

/** The stored side of a diff: the catalog and the last refresh's missing list. */
/** What changed about one allowlisted Prometheus metric (#386). */
export interface MetricChange {
  metric: string;
  addedLabels: string[];
  removedLabels: string[];
  /** The metric's type as the endpoint now reports it, when that changed. */
  type?: { from: string; to: string };
}

/**
 * A Prometheus catalog refresh, in the kind's own words. Like a SQL refresh,
 * it never edits the allowlist: a metric with no series is reported missing
 * and keeps its last known labels.
 */
export interface MetricCatalogDiff {
  missingMetrics: string[];
  restoredMetrics: string[];
  metrics: MetricChange[];
}

export type AnyCatalogDiff = CatalogDiff | MetricCatalogDiff;

export function isMetricDiff(diff: AnyCatalogDiff): diff is MetricCatalogDiff {
  return "metrics" in diff;
}

interface MetricCatalog {
  metrics: { name: string; type: string; labels: string[] }[];
}

export function diffMetricCatalog(
  stored: { config: MetricCatalog; catalogMissingTables: string[] },
  next: { config: MetricCatalog; missingTables: string[] },
): MetricCatalogDiff {
  const missing = new Set(next.missingTables);
  const before = new Map(stored.config.metrics.map((m) => [m.name, m]));
  const metrics: MetricChange[] = [];
  for (const metric of next.config.metrics) {
    if (missing.has(metric.name)) continue;
    const old = before.get(metric.name);
    const oldLabels = new Set(old?.labels ?? []);
    const nowLabels = new Set(metric.labels);
    const addedLabels = metric.labels.filter((l) => !oldLabels.has(l));
    const removedLabels = [...oldLabels].filter((l) => !nowLabels.has(l));
    const type =
      old && old.type !== metric.type ? { from: old.type, to: metric.type } : undefined;
    if (addedLabels.length + removedLabels.length > 0 || type) {
      metrics.push({
        metric: metric.name,
        addedLabels,
        removedLabels,
        ...(type ? { type } : {}),
      });
    }
  }
  return {
    missingMetrics: [...next.missingTables],
    restoredMetrics: stored.catalogMissingTables.filter((name) => !missing.has(name)),
    metrics,
  };
}

export type StoredCatalog = Pick<CatalogSubject, "config" | "catalogMissingTables">;

/** The introspected side: what `refreshCatalog()` returned. */
export interface IntrospectedCatalog {
  config: SqlSourceConfig;
  missingTables: string[];
}

/**
 * Compare the stored catalog with a fresh introspection, table by table and
 * column by column, by name.
 *
 * A missing table is reported in `missingTables` and nowhere else.
 * `refreshCatalog()` keeps its last known columns, so it has no column changes
 * to report anyway, and listing it twice would hide the real problem.
 */
export function diffCatalog(
  stored: StoredCatalog,
  next: IntrospectedCatalog,
): CatalogDiff {
  const missing = new Set(next.missingTables);
  const before = new Map(stored.config.tables.map((t) => [t.name, t]));
  const tables: TableChange[] = [];

  for (const table of next.config.tables) {
    if (missing.has(table.name)) continue;
    const old = new Map((before.get(table.name)?.columns ?? []).map((c) => [c.name, c]));
    const now = new Set(table.columns.map((c) => c.name));

    const added = table.columns.filter((c) => !old.has(c.name));
    const removed = [...old.values()].filter((c) => !now.has(c.name));
    const retyped: RetypedColumn[] = [];
    for (const column of table.columns) {
      const prior = old.get(column.name);
      if (prior && prior.type !== column.type) {
        retyped.push({ name: column.name, from: prior.type, to: column.type });
      }
    }
    if (added.length + removed.length + retyped.length > 0) {
      tables.push({ table: table.name, added, removed, retyped });
    }
  }

  return {
    missingTables: [...next.missingTables],
    restoredTables: stored.catalogMissingTables.filter((name) => !missing.has(name)),
    tables,
  };
}

/** True when applying would change nothing but the freshness timestamp. */
export function isUnchanged(diff: AnyCatalogDiff): boolean {
  if (isMetricDiff(diff)) {
    return (
      diff.missingMetrics.length === 0 &&
      diff.restoredMetrics.length === 0 &&
      diff.metrics.length === 0
    );
  }
  return (
    diff.missingTables.length === 0 &&
    diff.restoredTables.length === 0 &&
    diff.tables.length === 0
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** One line for the whole change set: the review's heading and the notice after it. */
export function summarizeCatalogDiff(diff: AnyCatalogDiff): string {
  if (isMetricDiff(diff)) return summarizeMetricDiff(diff);
  const count = (pick: (t: TableChange) => unknown[]) =>
    diff.tables.reduce((n, t) => n + pick(t).length, 0);
  const parts = [
    diff.missingTables.length > 0 &&
      `${plural(diff.missingTables.length, "table")} missing`,
    diff.restoredTables.length > 0 &&
      `${plural(diff.restoredTables.length, "table")} found again`,
    count((t) => t.added) > 0 &&
      `${plural(
        count((t) => t.added),
        "column",
      )} added`,
    count((t) => t.removed) > 0 &&
      `${plural(
        count((t) => t.removed),
        "column",
      )} removed`,
    count((t) => t.retyped) > 0 &&
      `${plural(
        count((t) => t.retyped),
        "column type",
      )} changed`,
  ].filter((part): part is string => typeof part === "string");
  return parts.length > 0
    ? `${parts.join(", ")}.`
    : "No changes since the last refresh. The catalog still matches the database.";
}

/** Hidden columns the database has dropped: re-adding one would expose it. */
function summarizeMetricDiff(diff: MetricCatalogDiff): string {
  const count = (pick: (m: MetricChange) => number) =>
    diff.metrics.reduce((n, m) => n + pick(m), 0);
  const parts = [
    diff.missingMetrics.length > 0 &&
      `${plural(diff.missingMetrics.length, "metric")} missing`,
    diff.restoredMetrics.length > 0 &&
      `${plural(diff.restoredMetrics.length, "metric")} found again`,
    count((m) => m.addedLabels.length) > 0 &&
      `${plural(
        count((m) => m.addedLabels.length),
        "label",
      )} added`,
    count((m) => m.removedLabels.length) > 0 &&
      `${plural(
        count((m) => m.removedLabels.length),
        "label",
      )} removed`,
    count((m) => (m.type ? 1 : 0)) > 0 &&
      `${plural(
        count((m) => (m.type ? 1 : 0)),
        "metric type",
      )} changed`,
  ].filter((part): part is string => typeof part === "string");
  return parts.length > 0
    ? `${parts.join(", ")}.`
    : "No changes since the last refresh. The catalog still matches the endpoint.";
}

export function droppedHiddenColumns(diff: AnyCatalogDiff): string[] {
  if (isMetricDiff(diff)) return [];
  return diff.tables.flatMap((t) =>
    t.removed.filter((c) => !isExposed(c)).map((c) => `${t.table}.${c.name}`),
  );
}

// --- Fetch helpers ---------------------------------------------------------------

export interface RefreshPreview {
  diff: AnyCatalogDiff;
  /** What the apply step must send back. */
  digest: string;
}

export type PreviewResult =
  | { ok: true; preview: RefreshPreview }
  | { ok: false; error: ApiError };

export type ApplyResult =
  | { ok: true; diff: AnyCatalogDiff; catalogHealth: CatalogHealth }
  /** The database changed between the preview and the apply. */
  | { ok: false; changed: RefreshPreview; error: ApiError }
  | { ok: false; changed?: undefined; error: ApiError };

function refreshUrl(sourceId: string): string {
  return `/api/sources/${encodeURIComponent(sourceId)}/refresh`;
}

/** Introspect, and show what would change. Writes nothing. */
export async function previewCatalogRefresh(sourceId: string): Promise<PreviewResult> {
  const res = await fetch(refreshUrl(sourceId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) return { ok: false, error: await readApiError(res) };
  return { ok: true, preview: (await res.json()) as RefreshPreview };
}

/** Write the previewed refresh, if the database still matches it. */
export async function applyCatalogRefresh(
  sourceId: string,
  digest: string,
): Promise<ApplyResult> {
  const res = await fetch(refreshUrl(sourceId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ digest }),
  });
  if (res.status === 409) {
    const body = (await res.json().catch(() => null)) as Partial<RefreshPreview> | null;
    const error = apiErrorFrom(409, body, res.headers.get("x-request-id") ?? undefined);
    if (body?.diff && typeof body.digest === "string") {
      return { ok: false, changed: { diff: body.diff, digest: body.digest }, error };
    }
    return { ok: false, error };
  }
  if (!res.ok) return { ok: false, error: await readApiError(res) };
  const body = (await res.json()) as {
    diff: AnyCatalogDiff;
    catalogHealth: CatalogHealth;
  };
  return { ok: true, diff: body.diff, catalogHealth: body.catalogHealth };
}
