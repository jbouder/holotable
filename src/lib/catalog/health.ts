import { config } from "@/lib/config";
import type { CatalogTable, SourceRecord } from "@/lib/registry";

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

/** What `catalogHealth` needs of a source: the catalog and the two facts. */
export type CatalogSubject = Pick<
  SourceRecord,
  "id" | "name" | "config" | "catalogRefreshedAt" | "catalogMissingTables"
>;

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

/** The state of a source's catalog, and everything the wording below needs. */
export function catalogHealth(
  source: CatalogSubject,
  opts: CatalogHealthOptions = {},
): CatalogHealth {
  const staleAfterDays = opts.staleAfterDays ?? config.catalogStaleAfterDays;
  const now = (opts.now ?? new Date()).getTime();

  const live = liveCatalogTables(source);
  const missingTables = [...source.catalogMissingTables];

  // An unparseable timestamp is treated as no timestamp: "never refreshed" is
  // the conservative reading, and it is the one with a fix attached.
  const parsed = source.catalogRefreshedAt ? Date.parse(source.catalogRefreshedAt) : NaN;
  const refreshedAt = Number.isFinite(parsed) ? source.catalogRefreshedAt : null;
  const ageDays = refreshedAt === null ? null : Math.floor((now - parsed) / MS_PER_DAY);

  const state: CatalogHealthState =
    live.length === 0 || live.every((table) => table.columns.length === 0)
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
    liveTableCount: live.length,
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
      return `${plural(health.missingTables.length, "table")} missing`;
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
  switch (health.state) {
    case "ok":
      return `The catalog for "${source.name}" matched the database at the last refresh.`;
    case "empty":
      return `The catalog for "${source.name}" describes no table that exists in the database, so nothing can be queried through it. ${fix} and choose its tables again.`;
    case "never_refreshed":
      return `The catalog for "${source.name}" has never been checked against the database, so its tables and columns are unverified and generated SQL is likely to fail. ${fix} first.`;
    case "drifted": {
      const n = health.missingTables.length;
      return `${plural(n, "table")} in "${source.name}" ${n === 1 ? "no longer exists" : "no longer exist"} in the database (${health.missingTables.join(", ")}). ${fix} and adjust its tables.`;
    }
    case "stale":
      return `The catalog for "${source.name}" was last refreshed ${plural(health.ageDays ?? 0, "day")} ago and may no longer match the database. ${fix}.`;
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
