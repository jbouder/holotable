import { cache } from "react";
import { can, HttpError } from "@/lib/auth/authorize";
import type { Identity } from "@/lib/auth/claims";
import {
  getDashboardById,
  getUserPreferences,
  mergeUserPreferences,
} from "@/lib/db/repo";
import { log } from "@/lib/log";
import {
  DEFAULT_PREFERENCES,
  parsePreferences,
  parsePreferencesPatch,
  type Preferences,
  startDashboardId,
} from "@/lib/preferences";

/**
 * Reading and writing a person's preferences (#213). Server-only.
 *
 * Every function takes the caller's {@link Identity} and uses its `sub`; none
 * takes a subject from anywhere else, which is the whole of "no route touches
 * another person's row". The store and the dashboard lookup are parameters so
 * tests can hand in plain objects; the defaults are the database.
 */

export interface PreferenceStore {
  read(sub: string): Promise<unknown | null>;
  merge(sub: string, patch: Record<string, unknown>): Promise<unknown>;
}

/** Where a dashboard lives, or null when there is no such (live) dashboard. */
export type DashboardLookup = (id: string) => Promise<{ workspaceId: string } | null>;

const databaseStore: PreferenceStore = {
  read: getUserPreferences,
  merge: mergeUserPreferences,
};

const databaseLookup: DashboardLookup = async (id) => {
  const record = await getDashboardById(id);
  return record ? { workspaceId: record.workspaceId } : null;
};

/**
 * The caller's resolved preferences. A database that does not answer yields
 * the defaults rather than an error page: a preference is a convenience, and
 * a dashboard that renders in browser-local time beats one that does not
 * render.
 */
export async function loadPreferences(
  identity: Identity,
  store?: PreferenceStore,
): Promise<Preferences> {
  try {
    const s = store ?? databaseStore;
    return parsePreferences(await s.read(identity.sub));
  } catch (err) {
    log.warn("preferences.read_failed", { err });
    return { ...DEFAULT_PREFERENCES };
  }
}

/** One read per request, however many server components ask. */
export const requestPreferences = cache(
  (identity: Identity): Promise<Preferences> => loadPreferences(identity),
);

/**
 * Validate and merge a PATCH body for the caller. A start dashboard must be
 * one the caller can view today; the picker only offers those, and the check
 * here is what makes that true for a hand-written request too.
 */
export async function savePreferences(
  identity: Identity,
  body: unknown,
  deps: { store?: PreferenceStore; lookup?: DashboardLookup } = {},
): Promise<Preferences> {
  const result = parsePreferencesPatch(body);
  if (!result.ok) {
    throw new HttpError(400, `invalid preference: ${result.field} ${result.message}`);
  }
  const { patch } = result;

  const dashboardId = patch.startPage ? startDashboardId(patch.startPage) : null;
  if (dashboardId) {
    const lookup = deps.lookup ?? databaseLookup;
    const target = await lookup(dashboardId);
    if (
      !target ||
      !can(identity, "dashboard:view", { workspaceId: target.workspaceId })
    ) {
      throw new HttpError(
        400,
        "invalid preference: startPage names a dashboard you cannot view",
      );
    }
  }

  const store = deps.store ?? databaseStore;
  return parsePreferences(await store.merge(identity.sub, patch));
}

/** The query flag the list reads to say the start dashboard was unavailable. */
export const START_UNAVAILABLE_NOTICE = "start-unavailable";

/**
 * Where to send someone who has just signed in, or who opened `/`. A start
 * dashboard that has been deleted, or that they can no longer view, falls back
 * to the list with a notice rather than a 404.
 */
export async function startHref(
  identity: Identity,
  prefs: Preferences,
  lookup?: DashboardLookup,
): Promise<string> {
  if (prefs.startPage === "explore") return "/explore";
  const id = startDashboardId(prefs.startPage);
  if (!id) return "/dashboards";
  try {
    const find = lookup ?? databaseLookup;
    const target = await find(id);
    if (target && can(identity, "dashboard:view", { workspaceId: target.workspaceId })) {
      return `/dashboards/${id}`;
    }
  } catch (err) {
    log.warn("preferences.start_lookup_failed", { err });
  }
  return `/dashboards?notice=${START_UNAVAILABLE_NOTICE}`;
}
