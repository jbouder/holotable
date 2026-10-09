import { config } from "@/lib/config";
import {
  type CatalogTable,
  exposedTable,
  type SourceRecord,
  type SqlSourceRecord,
} from "@/lib/registry";

/**
 * Whether a source's catalog can still be believed.
 *
 * The catalog is what the model is told the database contains, and it is the
 * only thing standing between a plain-English request and SQL against columns
 * that do not exist. Two ways it goes wrong were previously invisible:
 *
 * - a source drafted by the model ships a table it invented, and nothing has
 *   ever checked that table against the database;
 * - a table is dropped after the fact, and `refreshCatalog()` used to keep its
 *   last known columns rather than report it gone.
 *
 * In both cases generation proceeded and the author met the failure later as a
 * broken panel. This module is the single judgement about that: a state per
 * source, which of those states refuse generation, and the wording every
 * surface uses so the API's 400 and the badge in the list say the same thing.
 *
 * It is pure and synchronous. Nothing here reaches the database; the facts it
 * reads (`catalogRefreshedAt`, `catalogMissingTables`) are recorded by the
 * refresh route.
 */

export type CatalogHealthState = "ok" | "empty" | "never_refreshed" | "stale" | "drifted";

/** What the SQL catalog helpers need of a source: the catalog and the two facts. */
export type CatalogSubject = Pick<
  SqlSourceRecord,
  "id" | "name" | "config" | "catalogRefreshedAt" | "catalogMissingTables"
>;

/**
 * What `catalogHealth` needs of a source of any kind (#385). Its allowlist
 * entries are tables for SQL and metrics for PromQL; `catalogMissingTables`
 * holds the entries the last refresh could not find, whichever they are.
 */
export type HealthSubject = Pick<
  SourceRecord,
  "id" | "name" | "config" | "catalogRefreshedAt" | "catalogMissingTables"
>;

/** How many allowlist entries are still true: a table with columns, or a metric. */
function liveEntryCount(source: HealthSubject): number {
  const missing = new Set(source.catalogMissingTables);
  if ("tables" in source.config) {
    return source.config.tables.filter(
      (t) => !missing.has(t.name) && t.columns.length > 0,
    ).length;
  }
  return source.config.metrics.filter((m) => !missing.has(m.name)).length;
}

export interface CatalogHealth {
  state: CatalogHealthState;
  /**
   * Whether generation is refused against this source. `empty` and
   * `never_refreshed` mean the catalog was never true or is no longer true of
   * anything; `stale` and `drifted` are warnings, because part of the catalog
   * is still good and refusing would be worse than the risk.
   */
  blocked: boolean;
  /** Allowlisted tables the last refresh could not find, as it spelled them. */
  missingTables: string[];
  /** How many allowlisted tables the database still has. */
  liveTableCount: number;
  /** When the catalog was last introspected; null if never. */
  refreshedAt: string | null;
  /** Whole days since that refresh; null if never (or if the value is junk). */
  ageDays: number | null;
  /**
   * What the allowlist holds, for the wording (#386): `metric` for a
   * Prometheus source. Absent for SQL, whose entries are tables, so every
   * health judged before there was a second kind reads as it did.
   */
  entries?: "metric";
}

/** The words a health message uses for a source's allowlist and where it lives. */
function words(health: CatalogHealth): { entry: string; home: string; query: string } {
  return health.entries === "metric"
    ? { entry: "metric", home: "endpoint", query: "PromQL" }
    : { entry: "table", home: "database", query: "SQL" };
}

const MS_PER_DAY = 86_400_000;

export interface CatalogHealthOptions {
  /** Defaults to `CATALOG_STALE_AFTER_DAYS`. `0` disables the stale check. */
  staleAfterDays?: number;
  now?: Date;
}

/**
 * The allowlisted tables the last refresh still found.
 *
 * A missing table stays in the allowlist — a refresh must not quietly edit
 * what its author chose, and a permission blip is not a schema change — so
 * "the catalog" and "the part of it that is still true" are different sets.
 * This is the second one, and it is what the prompt is built from.
 */
export function liveCatalogTables(source: CatalogSubject): CatalogTable[] {
  if (source.catalogMissingTables.length === 0) return source.config.tables;
  const missing = new Set(source.catalogMissingTables);
  return source.config.tables.filter((table) => !missing.has(table.name));
}

/**
 * The live tables as they may be described: each with only its exposed
 * columns. This is what the prompt, the starter prompts and the built-in
 * templates are built from, so a column the author hid is never named to the
 * model and never written into a suggestion the guard would then refuse.
 *
 * Health is judged on {@link liveCatalogTables} instead: hiding a column is a
 * choice about what may be read, not evidence that the catalog is wrong.
 */
export function exposedCatalogTables(source: CatalogSubject): CatalogTable[] {
  return liveCatalogTables(source).map(exposedTable);
}

/** The state of a source's catalog, and everything the wording below needs. */
export function catalogHealth(
  source: HealthSubject,
  opts: CatalogHealthOptions = {},
): CatalogHealth {
  const staleAfterDays = opts.staleAfterDays ?? config.catalogStaleAfterDays;
  const now = (opts.now ?? new Date()).getTime();

  const live = liveEntryCount(source);
  const missingTables = [...source.catalogMissingTables];

  // An unparseable timestamp is treated as no timestamp: "never refreshed" is
  // the conservative reading, and it is the one with a fix attached.
  const parsed = source.catalogRefreshedAt ? Date.parse(source.catalogRefreshedAt) : NaN;
  const refreshedAt = Number.isFinite(parsed) ? source.catalogRefreshedAt : null;
  const ageDays = refreshedAt === null ? null : Math.floor((now - parsed) / MS_PER_DAY);

  const state: CatalogHealthState =
    live === 0
      ? "empty"
      : refreshedAt === null
        ? "never_refreshed"
        : missingTables.length > 0
          ? "drifted"
          : staleAfterDays > 0 && ageDays !== null && ageDays > staleAfterDays
            ? "stale"
            : "ok";

  return {
    state,
    blocked: state === "empty" || state === "never_refreshed",
    missingTables,
    liveTableCount: live,
    ...("metrics" in source.config ? { entries: "metric" as const } : {}),
    refreshedAt,
    ageDays,
  };
}

/** Two or three words for a badge. */
export function catalogHealthLabel(health: CatalogHealth): string {
  switch (health.state) {
    case "ok":
      return "Catalog fresh";
    case "empty":
      return "Catalog empty";
    case "never_refreshed":
      return "Never refreshed";
    case "drifted":
      return `${plural(health.missingTables.length, words(health).entry)} missing`;
    case "stale":
      return "Catalog stale";
  }
}

/**
 * The sentence shown beside the badge and returned by a refused generation.
 *
 * Every non-ok state names the problem and then the fix, in that order, and
 * the fix is always the Refresh the UI puts one click away — there is no state
 * here whose remedy is something the reader has to go and work out.
 */
export function describeCatalogHealth(
  source: Pick<CatalogSubject, "id" | "name">,
  health: CatalogHealth,
): string {
  const fix = `Refresh the catalog for source ${source.id}`;
  const { entry, home, query } = words(health);
  const parts = entry === "table" ? "tables and columns" : "metrics and labels";
  switch (health.state) {
    case "ok":
      return `The catalog for "${source.name}" matched the ${home} at the last refresh.`;
    case "empty":
      return `The catalog for "${source.name}" describes no ${entry} that exists in the ${home}, so nothing can be queried through it. ${fix} and choose its ${entry}s again.`;
    case "never_refreshed":
      return `The catalog for "${source.name}" has never been checked against the ${home}, so its ${parts} are unverified and generated ${query} is likely to fail. ${fix} first.`;
    case "drifted": {
      const n = health.missingTables.length;
      return `${plural(n, entry)} in "${source.name}" ${n === 1 ? "no longer exists" : "no longer exist"} in the ${home} (${health.missingTables.join(", ")}). ${fix} and adjust its ${entry}s.`;
    }
    case "stale":
      return `The catalog for "${source.name}" was last refreshed ${plural(health.ageDays ?? 0, "day")} ago and may no longer match the ${home}. ${fix}.`;
  }
}

/**
 * The message for a refused generation, or null when generation may proceed.
 * One function so the route cannot decide differently from the badge.
 */
export function catalogRefusal(
  source: Pick<CatalogSubject, "id" | "name">,
  health: CatalogHealth,
): string | null {
  return health.blocked ? describeCatalogHealth(source, health) : null;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
