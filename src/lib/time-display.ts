/**
 * How an instant is shown to a person (#214): in which time zone, and on which
 * clock.
 *
 * Display only. Every stored and transmitted time stays UTC ISO-8601, and the
 * server still resolves every window (invariant 4); this module decides what a
 * label says and how an `<input type="datetime-local">` value maps back to an
 * instant, nothing else. It is pure and client-safe, so a component and a test
 * format the same way.
 */

export const CLOCKS = ["locale", "12h", "24h"] as const;
export type Clock = (typeof CLOCKS)[number];

/** `"local"` is the browser's own zone; anything else is an IANA name. */
export type TimeZonePreference = "local" | string;

export interface TimeDisplay {
  timeZone: TimeZonePreference;
  clock: Clock;
}

export const LOCAL_TIME_DISPLAY: TimeDisplay = { timeZone: "local", clock: "locale" };

/** Whether `Intl` recognises this IANA zone name. */
export function isValidTimeZone(zone: string): boolean {
  if (!zone || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The zone to hand `Intl`, or undefined for the runtime's own. */
function intlZone(display: TimeDisplay): string | undefined {
  return display.timeZone === "local" ? undefined : display.timeZone;
}

function clockOptions(clock: Clock): Intl.DateTimeFormatOptions {
  if (clock === "12h") return { hourCycle: "h12" };
  if (clock === "24h") return { hourCycle: "h23" };
  return {};
}

/**
 * Month, day, hour and minute, e.g. "Sep 22, 14:05". `seconds` adds the
 * seconds and `year` the year, for labels that need them.
 */
export function formatDateTime(
  date: Date,
  display: TimeDisplay = LOCAL_TIME_DISPLAY,
  opts: { seconds?: boolean; year?: boolean } = {},
): string {
  return date.toLocaleString(undefined, {
    ...(opts.year ? { year: "numeric" } : {}),
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    ...(opts.seconds ? { second: "2-digit" } : {}),
    timeZone: intlZone(display),
    ...clockOptions(display.clock),
  });
}

/**
 * A wall-clock time with seconds. On the locale clock it is the zero-padded
 * 24-hour `14:05:09` the live indicator has always shown, stable across
 * locales; the 12-hour clock reads `2:05:09 PM`.
 */
export function formatClock(
  date: Date,
  display: TimeDisplay = LOCAL_TIME_DISPLAY,
): string {
  const twelve = display.clock === "12h";
  const text = new Intl.DateTimeFormat(twelve ? undefined : "en-GB", {
    hour: twelve ? "numeric" : "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: twelve ? "h12" : "h23",
    timeZone: intlZone(display),
  }).format(date);
  return text;
}

interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The calendar fields of `date` as a clock in the chosen zone shows them. */
export function wallTime(date: Date, display: TimeDisplay): WallTime {
  if (display.timeZone === "local") {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
    };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: display.timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    // `h23` should never print 24, but some engines have.
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

/** `Date` → the value a `datetime-local` input wants, on the chosen zone's clock. */
export function toZonedInput(
  date: Date,
  display: TimeDisplay = LOCAL_TIME_DISPLAY,
): string {
  const w = wallTime(date, display);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}`;
}

const INPUT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * The inverse of {@link toZonedInput}: a wall-clock reading in the chosen zone
 * back to an instant, `null` for anything unparseable.
 *
 * A zone's offset depends on the instant, so the reading is tried under the
 * offset in force a day before and a day after, and the candidates that read
 * back the same are kept. A reading that occurs twice in a fall-back takes the
 * earlier occurrence; one that falls in a spring-forward gap does not exist on
 * that clock and lands just past it, under the earlier offset.
 */
export function fromZonedInput(
  value: string,
  display: TimeDisplay = LOCAL_TIME_DISPLAY,
): Date | null {
  const m = INPUT_RE.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1, 6).map(Number);
  const second = m[6] ? Number(m[6]) : 0;

  if (display.timeZone === "local") {
    const date = new Date(year, month - 1, day, hour, minute, second);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  if (Number.isNaN(asUtc)) return null;
  const offsetAt = (instant: number) => {
    const w = wallTime(new Date(instant), display);
    return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - instant;
  };
  // No zone changes offset twice within a day, so the offsets a day either
  // side are the only two this reading can have been taken under.
  const before = offsetAt(asUtc - DAY_MS);
  const after = offsetAt(asUtc + DAY_MS);
  const wanted = value.slice(0, 16);
  const matches = [asUtc - before, asUtc - after]
    .filter((c) => toZonedInput(new Date(c), display) === wanted)
    .sort((a, b) => a - b);
  return new Date(matches[0] ?? asUtc - before);
}

const DAY_MS = 86_400_000;

/** The runtime's own IANA zone, e.g. "Europe/Berlin". */
export function runtimeTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * The chosen zone when it is not the browser's, for a label beside a time
 * control; `null` when the browser's clock is what is showing anyway.
 */
export function zoneBadge(
  display: TimeDisplay,
  browserZone: string = runtimeTimeZone(),
): string | null {
  if (display.timeZone === "local" || display.timeZone === browserZone) return null;
  return display.timeZone === "Etc/UTC" ? "UTC" : display.timeZone;
}
