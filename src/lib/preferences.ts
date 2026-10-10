import { z } from "zod";
import { DASHBOARD_SORTS, DEFAULT_SORT, type DashboardSort } from "@/lib/dashboard-list";
import {
  CHAT_TIME_RANGE_VALUES,
  type ChatRefreshMs,
  type ChatTimeRange,
  isChatRefreshMs,
} from "@/lib/chat/defaults";
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
 * Chart patterns (`chartPatterns`) sync too, though they look like an
 * appearance setting: they are an accessibility need of the person (telling
 * series apart without color), and they apply when a chart draws, after
 * hydration, so nothing has to land before first paint.
 *
 * Whether to keep those recents at all does sync (`remember*`): "do not keep
 * what I asked" is a choice about the person, and a second laptop quietly
 * starting to record again would break it. The lists themselves still never
 * leave the browser. Chat's defaults (`chat*`) sync like the rest. `rememberChats` is the one `remember*` that governs a
 * server-side store: Chat conversations (#416), which it deletes when off.
 *
 * Preferences are personal: keyed by `sub` alone, never by workspace, and no
 * route reads or writes a subject other than the caller's own.
 */

/** Where the app opens after sign-in: a page, or one dashboard by id. */
export const START_PAGES = ["dashboards", "chat"] as const;
export type StartPage = (typeof START_PAGES)[number] | `dashboard:${string}`;

const DASHBOARD_START =
  /^dashboard:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** The dashboard id a start page names, or null for a plain page. */
export function startDashboardId(start: StartPage): string | null {
  return DASHBOARD_START.exec(start)?.[1] ?? null;
}

/**
 * Explore became Chat (#416): a start page stored as `"explore"` lands on
 * Chat, and is written back as `"chat"` on the next save.
 */
const StartPageSchema = z.preprocess(
  (v) => (v === "explore" ? "chat" : v),
  z.custom<StartPage>(
    (v) =>
      typeof v === "string" &&
      ((START_PAGES as readonly string[]).includes(v) || DASHBOARD_START.test(v)),
    { message: 'must be "dashboards", "chat" or "dashboard:<id>"' },
  ),
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
  rememberPrompts: z.boolean({ error: "must be true or false" }),
  rememberRecentDashboards: z.boolean({ error: "must be true or false" }),
  rememberPaletteHistory: z.boolean({ error: "must be true or false" }),
  chartPatterns: z.boolean({ error: "must be true or false" }),
  chatTimeRange: z.enum(CHAT_TIME_RANGE_VALUES, {
    error: `must be one of ${CHAT_TIME_RANGE_VALUES.join(", ")}`,
  }),
  chatRefreshMs: z.custom<ChatRefreshMs>(isChatRefreshMs, {
    message: "must be 0, 30000, 60000 or 300000",
  }),
  chatShowQueries: z.boolean({ error: "must be true or false" }),
  rememberChats: z.boolean({ error: "must be true or false" }),
} as const;

export interface Preferences {
  timeZone: string;
  clock: Clock;
  startPage: StartPage;
  dashboardSort: DashboardSort;
  favoritesOnly: boolean;
  /** Keep recent prompts, and the source last generated from, in this browser. */
  rememberPrompts: boolean;
  /** Keep the dashboard list's "Recent" row. */
  rememberRecentDashboards: boolean;
  /** Keep the command palette's recent commands. */
  rememberPaletteHistory: boolean;
  /**
   * Fill chart bars, slices and areas with patterns as well as colors, so
   * series can be told apart without color (WCAG 1.4.1). Off by default.
   */
  chartPatterns: boolean;
  /** The range a new Chat conversation starts with (#416). */
  chatTimeRange: ChatTimeRange;
  /** How often Chat re-runs the panels on screen (#416); 0 is off. */
  chatRefreshMs: ChatRefreshMs;
  /** Open every Chat panel's and citation's query by default. */
  chatShowQueries: boolean;
  /**
   * Keep Chat conversations on the server (#416). Off, a conversation lives
   * in the page and is gone on reload, and turning it off deletes every
   * stored one.
   */
  rememberChats: boolean;
}

export type PreferenceKey = keyof Preferences;

export const DEFAULT_PREFERENCES: Preferences = {
  timeZone: "local",
  clock: "locale",
  startPage: "dashboards",
  dashboardSort: DEFAULT_SORT,
  favoritesOnly: false,
  rememberPrompts: true,
  rememberRecentDashboards: true,
  rememberPaletteHistory: true,
  chartPatterns: false,
  chatTimeRange: "now-24h",
  chatRefreshMs: 0,
  chatShowQueries: false,
  rememberChats: true,
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
  const record = withExploreAliases(raw as Record<string, unknown>);
  for (const key of KEYS) {
    if (!(key in record)) continue;
    const parsed = PREFERENCE_FIELDS[key].safeParse(record[key]);
    if (parsed.success) (out as unknown as Record<string, unknown>)[key] = parsed.data;
  }
  return out;
}

/**
 * Explore's defaults, read as Chat's for one release (#416): a row written
 * before Explore became Chat keeps its range and refresh. The stored row is
 * not rewritten here; the next save of either field writes the new name.
 */
function withExploreAliases(record: Record<string, unknown>): Record<string, unknown> {
  const aliased = { ...record };
  if (!("chatTimeRange" in aliased) && "exploreTimeRange" in aliased) {
    aliased.chatTimeRange = aliased.exploreTimeRange;
  }
  if (!("chatRefreshMs" in aliased) && "exploreRefreshMs" in aliased) {
    aliased.chatRefreshMs = aliased.exploreRefreshMs;
  }
  return aliased;
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

/** Which recents this person keeps, as the browser-side gates read it. */
export interface HistoryPreferences {
  prompts: boolean;
  recentDashboards: boolean;
  paletteHistory: boolean;
}

export const KEEP_ALL_HISTORY: HistoryPreferences = {
  prompts: true,
  recentDashboards: true,
  paletteHistory: true,
};

export function historyOf(prefs: Preferences): HistoryPreferences {
  return {
    prompts: prefs.rememberPrompts,
    recentDashboards: prefs.rememberRecentDashboards,
    paletteHistory: prefs.rememberPaletteHistory,
  };
}

/** The `remember*` fields a patch turns off, as the local stores to clear. */
export function historyTurnedOff(
  patch: PreferencesPatch,
): ("prompts" | "recent-dashboards" | "palette-recents")[] {
  const off: ("prompts" | "recent-dashboards" | "palette-recents")[] = [];
  if (patch.rememberPrompts === false) off.push("prompts");
  if (patch.rememberRecentDashboards === false) off.push("recent-dashboards");
  if (patch.rememberPaletteHistory === false) off.push("palette-recents");
  return off;
}

/** What Chat opens with and how it behaves, from the preferences (#416). */
export interface ChatPreferences {
  timeRange: ChatTimeRange;
  refreshMs: ChatRefreshMs;
  showQueries: boolean;
  remember: boolean;
}

export function chatPreferencesOf(prefs: Preferences): ChatPreferences {
  return {
    timeRange: prefs.chatTimeRange,
    refreshMs: prefs.chatRefreshMs,
    showQueries: prefs.chatShowQueries,
    remember: prefs.rememberChats,
  };
}
