/**
 * The choices Explore offers for its time range, auto-refresh and starting
 * view: one list, read by the page's menus and by the preferences that set
 * their defaults (`src/lib/preferences.ts`), so a saved default is always one
 * the page can show.
 *
 * Browser-safe. The time ranges are relative expressions; the server resolves
 * them on every run, as it does everywhere else.
 */

export const EXPLORE_TIME_RANGES = [
  { value: "now-5m", label: "Last 5 minutes" },
  { value: "now-15m", label: "Last 15 minutes" },
  { value: "now-1h", label: "Last 1 hour" },
  { value: "now-6h", label: "Last 6 hours" },
  { value: "now-12h", label: "Last 12 hours" },
  { value: "now-24h", label: "Last 24 hours" },
  { value: "now-7d", label: "Last 7 days" },
  { value: "now-30d", label: "Last 30 days" },
] as const;

export type ExploreTimeRange = (typeof EXPLORE_TIME_RANGES)[number]["value"];

export const EXPLORE_TIME_RANGE_VALUES = EXPLORE_TIME_RANGES.map((r) => r.value) as [
  ExploreTimeRange,
  ...ExploreTimeRange[],
];

/** Auto-refresh choices in milliseconds; 0 is off. */
export const EXPLORE_REFRESH_CHOICES = [
  { value: 0, short: "Off", label: "Off" },
  { value: 30_000, short: "30s", label: "Every 30s" },
  { value: 60_000, short: "1m", label: "Every 1m" },
  { value: 300_000, short: "5m", label: "Every 5m" },
] as const;

export type ExploreRefreshMs = (typeof EXPLORE_REFRESH_CHOICES)[number]["value"];

export function isExploreRefreshMs(value: unknown): value is ExploreRefreshMs {
  return EXPLORE_REFRESH_CHOICES.some((c) => c.value === value);
}

/** How an answer is first drawn: as the model proposed it, or as a table. */
export const EXPLORE_START_VIEWS = ["model", "table"] as const;
export type ExploreStartView = (typeof EXPLORE_START_VIEWS)[number];

export function timeRangeLabel(from: string): string {
  return EXPLORE_TIME_RANGES.find((r) => r.value === from)?.label ?? from;
}

export function refreshShortLabel(ms: number): string {
  return EXPLORE_REFRESH_CHOICES.find((c) => c.value === ms)?.short ?? "Off";
}

/** The defaults Explore opens with, from the person's preferences. */
export interface ExploreDefaults {
  timeRange: ExploreTimeRange;
  refreshMs: ExploreRefreshMs;
  startView: ExploreStartView;
  keepSession: boolean;
}
