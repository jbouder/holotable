import { z } from "zod";
import { DASHBOARD_SORTS, DEFAULT_SORT, type DashboardSort } from "@/lib/dashboard-list";
import {
  CLOCKS,
  type Clock,
  isValidTimeZone,
  type TimeDisplay,
} from "@/lib/time-display";

/**
 * A person's preferences (#213): one validated object per `sub`, stored in
 * `user_preferences` and read back through {@link parsePreferences}.
 *
 * WHAT SYNCS, AND WHAT DOES NOT. Everything in this schema follows a person
 * from device to device: how times are shown (#214), where they land after
 * signing in, and how the dashboard list opens (#215). Those are choices about
 * *them*, and a second laptop or a cleared browser silently resetting them is
 * the bug this table exists to fix.
 *
 * The theme and the reduced-motion choice deliberately stay in the browser
 * (`src/lib/theme.ts`). They must be applied by the inline script in the root
 * layout before first paint, which cannot wait on a database round-trip
 * without either flashing or blocking the page, and a device-specific choice
 * (a dark laptop, a light projector) is arguably the right scope for them
 * anyway. Drafts, recents and dismissed hints are per browser for the reasons
 * their own modules give.
 *
 * Preferences are personal: keyed by `sub` alone, never by workspace, and no
 * route reads or writes a subject other than the caller's own.
 */

/** Where the app opens after sign-in: a page, or one dashboard by id. */
export const START_PAGES = ["dashboards", "explore"] as const;
export type StartPage = (typeof START_PAGES)[number] | `dashboard:${string}`;

const DASHBOARD_START =
  /^dashboard:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** The dashboard id a start page names, or null for a plain page. */
export function startDashboardId(start: StartPage): string | null {
  return DASHBOARD_START.exec(start)?.[1] ?? null;
}

const StartPageSchema = z.custom<StartPage>(
  (v) =>
    typeof v === "string" &&
    ((START_PAGES as readonly string[]).includes(v) || DASHBOARD_START.test(v)),
  { message: 'must be "dashboards", "explore" or "dashboard:<id>"' },
);

const TimeZoneSchema = z.string().refine((v) => v === "local" || isValidTimeZone(v), {
  message: 'must be "local" or an IANA time zone such as "UTC" or "Europe/Berlin"',
});

/**
 * One schema per field, so a stored row is validated field by field: a value
 * that no longer parses falls back to its default without taking the others
 * with it.
 */
export const PREFERENCE_FIELDS = {
  timeZone: TimeZoneSchema,
  clock: z.enum(CLOCKS, { error: `must be one of ${CLOCKS.join(", ")}` }),
  startPage: StartPageSchema,
  dashboardSort: z.enum(DASHBOARD_SORTS, {
    error: `must be one of ${DASHBOARD_SORTS.join(", ")}`,
  }),
  favoritesOnly: z.boolean({ error: "must be true or false" }),
} as const;

export interface Preferences {
  timeZone: string;
  clock: Clock;
  startPage: StartPage;
  dashboardSort: DashboardSort;
  favoritesOnly: boolean;
}

export type PreferenceKey = keyof Preferences;

export const DEFAULT_PREFERENCES: Preferences = {
  timeZone: "local",
  clock: "locale",
  startPage: "dashboards",
  dashboardSort: DEFAULT_SORT,
  favoritesOnly: false,
};

const KEYS = Object.keys(PREFERENCE_FIELDS) as PreferenceKey[];

/**
 * A stored row, or nothing, as a complete {@link Preferences}. Never throws:
 * an unknown key is dropped and an invalid value takes its default, so an old
 * row written before a field changed shape never breaks a page.
 */
export function parsePreferences(raw: unknown): Preferences {
  const out: Preferences = { ...DEFAULT_PREFERENCES };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const record = raw as Record<string, unknown>;
  for (const key of KEYS) {
    if (!(key in record)) continue;
    const parsed = PREFERENCE_FIELDS[key].safeParse(record[key]);
    if (parsed.success) (out as unknown as Record<string, unknown>)[key] = parsed.data;
  }
  return out;
}

export type PreferencesPatch = Partial<Preferences>;

export type PatchResult =
  | { ok: true; patch: PreferencesPatch }
  | { ok: false; field: string; message: string };

/**
 * Validate a PATCH body: an object of known keys, each valid. Unlike
 * {@link parsePreferences} this is strict, and the error names the field, so
 * a client bug is a 400 that says what is wrong rather than a silent no-op.
 */
export function parsePreferencesPatch(body: unknown): PatchResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, field: "(body)", message: "must be a JSON object" };
  }
  const entries = Object.entries(body as Record<string, unknown>);
  if (entries.length === 0) {
    return { ok: false, field: "(body)", message: "must set at least one preference" };
  }
  const patch: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (!(KEYS as string[]).includes(key)) {
      return { ok: false, field: key, message: "is not a preference" };
    }
    const parsed = PREFERENCE_FIELDS[key as PreferenceKey].safeParse(value);
    if (!parsed.success) {
      return {
        ok: false,
        field: key,
        message: parsed.error.issues[0]?.message ?? "is invalid",
      };
    }
    patch[key] = parsed.data;
  }
  return { ok: true, patch: patch as PreferencesPatch };
}

/** The part of the preferences the time formatting reads. */
export function timeDisplayOf(
  prefs: Pick<Preferences, "timeZone" | "clock">,
): TimeDisplay {
  return { timeZone: prefs.timeZone, clock: prefs.clock };
}
