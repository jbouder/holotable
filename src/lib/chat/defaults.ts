/**
 * The choices Chat offers for its time range and live refresh (#416): one
 * list, read by the side panel and by the preferences that set their defaults
 * (`src/lib/preferences.ts`), so a saved default is always one the page can
 * show.
 *
 * Browser-safe. The time ranges are relative expressions; the server resolves
 * them on every run, as it does everywhere else.
 */

export const CHAT_TIME_RANGES = [
  { value: "now-5m", label: "Last 5 minutes" },
  { value: "now-15m", label: "Last 15 minutes" },
  { value: "now-1h", label: "Last 1 hour" },
  { value: "now-6h", label: "Last 6 hours" },
  { value: "now-12h", label: "Last 12 hours" },
  { value: "now-24h", label: "Last 24 hours" },
  { value: "now-7d", label: "Last 7 days" },
  { value: "now-30d", label: "Last 30 days" },
] as const;

export type ChatTimeRange = (typeof CHAT_TIME_RANGES)[number]["value"];

export const CHAT_TIME_RANGE_VALUES = CHAT_TIME_RANGES.map((r) => r.value) as [
  ChatTimeRange,
  ...ChatTimeRange[],
];

/** Live refresh choices in milliseconds; 0 is off. */
export const CHAT_REFRESH_CHOICES = [
  { value: 0, short: "Off", label: "Off" },
  { value: 30_000, short: "30s", label: "Every 30s" },
  { value: 60_000, short: "1m", label: "Every 1m" },
  { value: 300_000, short: "5m", label: "Every 5m" },
] as const;

export type ChatRefreshMs = (typeof CHAT_REFRESH_CHOICES)[number]["value"];

export function isChatRefreshMs(value: unknown): value is ChatRefreshMs {
  return CHAT_REFRESH_CHOICES.some((c) => c.value === value);
}

export function timeRangeLabel(from: string): string {
  return CHAT_TIME_RANGES.find((r) => r.value === from)?.label ?? from;
}

export function refreshShortLabel(ms: number): string {
  return CHAT_REFRESH_CHOICES.find((c) => c.value === ms)?.short ?? "Off";
}
