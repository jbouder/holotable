import { type Panel, TimeRange } from "@/lib/ir";
import { resolveTimeRange } from "@/lib/time";
import {
  formatDateTime,
  fromZonedInput,
  LOCAL_TIME_DISPLAY,
  type TimeDisplay,
  toZonedInput,
} from "@/lib/time-display";

/**
 * The vocabulary behind the dashboard time picker.
 *
 * Everything here produces a {@link TimeRange} of IR `TimeExpr` strings and
 * nothing here executes anything. The client proposes a window; the server
 * still resolves it (`resolveTimeRange`) on every tick and every query, so
 * invariant 4 — the server owns time — is untouched by any of this. Shifting
 * and zooming resolve locally only to do the arithmetic; the result goes back
 * out as expressions the server re-resolves for itself.
 *
 * Every function here returns something that parses as `TimeExpr`, and
 * `test/time-range.test.ts` asserts exactly that for the generated forms.
 */

export const UNIT_MS = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
} as const;

export type RelativeUnit = keyof typeof UNIT_MS;

/** Largest first: `relativeExpr` picks the first unit that divides evenly. */
const UNITS_DESCENDING: RelativeUnit[] = ["w", "d", "h", "m", "s"];

export const UNIT_LABELS: Record<RelativeUnit, string> = {
  s: "seconds",
  m: "minutes",
  h: "hours",
  d: "days",
  w: "weeks",
};

export const RANGE_PRESETS = [
  { label: "15m", from: "now-15m" },
  { label: "1h", from: "now-1h" },
  { label: "6h", from: "now-6h" },
  { label: "24h", from: "now-24h" },
  { label: "7d", from: "now-7d" },
] as const;

/** Windows narrower than this are not worth resolving, and `from < to` would break. */
const MIN_SPAN_MS = 1_000;

/** A week of seconds still fits `TimeExpr`'s 64 characters many times over. */
const MAX_SPAN_MS = 365 * UNIT_MS.d;

const RELATIVE_RE = /^now(?:-(\d+)([smhdw]))?$/;

export interface RelativeExpr {
  amount: number;
  unit: RelativeUnit;
}

/**
 * `now-15m` → `{ amount: 15, unit: "m" }`; bare `now` → amount 0. Anything
 * absolute (or malformed) is `null`, which is how callers tell the two kinds of
 * expression apart without a second regex.
 */
export function parseRelative(expr: string): RelativeExpr | null {
  const m = RELATIVE_RE.exec(expr);
  if (!m) return null;
  if (!m[1]) return { amount: 0, unit: "m" };
  return { amount: Number(m[1]), unit: m[2] as RelativeUnit };
}

/**
 * A range is "rolling" when both ends are relative: it follows `now` and the
 * data keeps arriving. An absolute range is frozen, and the viewer has to be
 * told so — a live badge over a fixed window is a lie about what is on screen.
 */
export function isRolling(range: TimeRange): boolean {
  return parseRelative(range.from) !== null && parseRelative(range.to) !== null;
}

/** ISO-8601 with the milliseconds trimmed, which is what `TimeExpr` accepts. */
export function isoExpr(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Milliseconds as the shortest relative expression that says exactly the same
 * thing: 5_400_000 → `now-90m`, never `now-1.5h`. `TimeExpr` has no fractions,
 * so the first unit that divides evenly is the only correct answer.
 */
export function relativeExpr(ms: number): string {
  const total = clampSpan(ms);
  for (const unit of UNITS_DESCENDING) {
    if (total % UNIT_MS[unit] === 0) return `now-${total / UNIT_MS[unit]}${unit}`;
  }
  return `now-${Math.max(1, Math.round(total / UNIT_MS.s))}s`;
}

function clampSpan(ms: number): number {
  const rounded = Math.round(ms);
  if (!Number.isFinite(rounded)) return MIN_SPAN_MS;
  return Math.min(MAX_SPAN_MS, Math.max(MIN_SPAN_MS, rounded));
}

/** A window's width in milliseconds, or `null` if it does not resolve. */
export function spanMs(range: TimeRange, now: Date = new Date()): number | null {
  try {
    const { from, to } = resolveTimeRange(range, now);
    return to.getTime() - from.getTime();
  } catch {
    return null;
  }
}

/**
 * Build a range from two instants. Always absolute: this is what a chart brush
 * and the absolute form both produce.
 */
export function absoluteRange(from: Date, to: Date): TimeRange | null {
  const span = to.getTime() - from.getTime();
  if (!Number.isFinite(span) || span < MIN_SPAN_MS) return null;
  const candidate = { from: isoExpr(from), to: isoExpr(to) };
  const parsed = TimeRange.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Move the window by whole multiples of its own width. Negative goes back.
 *
 * Shifting forward past `now` snaps back to the rolling form of the same width
 * rather than proposing a window in the future: the forward arrow is how a
 * reader who went looking at yesterday gets back to live, and an empty chart
 * ending at `now+1h` is not that.
 */
export function shiftRange(
  range: TimeRange,
  multiple: number,
  now: Date = new Date(),
): TimeRange {
  let resolved: { from: Date; to: Date };
  try {
    resolved = resolveTimeRange(range, now);
  } catch {
    return range;
  }
  const span = resolved.to.getTime() - resolved.from.getTime();
  const delta = span * multiple;
  const to = new Date(resolved.to.getTime() + delta);
  // The tolerance is the second that `isoExpr` truncates: a window shifted back
  // off `now` and then forward again lands up to 999ms short of it, and without
  // this the forward arrow would leave a "fixed range" badge on what is plainly
  // the live window.
  if (to.getTime() + MIN_SPAN_MS > now.getTime()) {
    return { from: relativeExpr(span), to: "now" };
  }
  return absoluteRange(new Date(resolved.from.getTime() + delta), to) ?? range;
}

/**
 * Scale the window around its own centre. `factor` 2 widens, 0.5 narrows.
 *
 * A range that ends at `now` stays anchored there and stays rolling — zooming
 * out of a live dashboard should not quietly freeze it.
 */
export function zoomRange(
  range: TimeRange,
  factor: number,
  now: Date = new Date(),
): TimeRange {
  const span = spanMs(range, now);
  if (span === null) return range;
  const next = clampSpan(span * factor);
  if (isRolling(range) && range.to === "now") {
    return { from: relativeExpr(next), to: "now" };
  }
  let resolved: { from: Date; to: Date };
  try {
    resolved = resolveTimeRange(range, now);
  } catch {
    return range;
  }
  const centre = (resolved.from.getTime() + resolved.to.getTime()) / 2;
  const half = next / 2;
  // Widening a window that already ends near `now` would otherwise propose a
  // future `to`, which resolves fine and returns nothing.
  const end = Math.min(centre + half, now.getTime());
  return absoluteRange(new Date(end - next), new Date(end)) ?? range;
}

/**
 * A relative range of the given width ending at `now` — the custom builder's
 * output, and the shape the presets already use.
 */
export function relativeRange(amount: number, unit: RelativeUnit): TimeRange | null {
  if (!Number.isInteger(amount) || amount < 1) return null;
  const parsed = TimeRange.safeParse({ from: `now-${amount}${unit}`, to: "now" });
  return parsed.success ? parsed.data : null;
}

/** The preset whose window this range is, if it is one of them. */
export function matchingPreset(range: TimeRange): string | null {
  if (range.to !== "now") return null;
  return RANGE_PRESETS.find((p) => p.from === range.from)?.label ?? null;
}

/** A span as the compact text the trigger and the badge both use. */
export function formatSpan(ms: number): string {
  for (const unit of UNITS_DESCENDING) {
    const size = UNIT_MS[unit];
    if (ms >= size) {
      const amount = ms / size;
      const text = Number.isInteger(amount) ? String(amount) : amount.toFixed(1);
      return `${text}${unit}`;
    }
  }
  return `${Math.max(1, Math.round(ms / 1000))}s`;
}

/**
 * The label on the picker's trigger. Presets keep their own name, other rolling
 * windows read as "Last 90m", and an absolute window shows its actual bounds —
 * a reader must be able to tell at a glance which of the three they are in.
 */
export function describeRange(
  range: TimeRange,
  now: Date = new Date(),
  display: TimeDisplay = LOCAL_TIME_DISPLAY,
): string {
  const preset = matchingPreset(range);
  if (preset) return preset;
  if (isRolling(range)) {
    const span = spanMs(range, now);
    if (span !== null && range.to === "now") return `Last ${formatSpan(span)}`;
    return `${range.from} → ${range.to}`;
  }
  try {
    const { from, to } = resolveTimeRange(range, now);
    return `${formatInstant(from, display)} → ${formatInstant(to, display)}`;
  } catch {
    return `${range.from} → ${range.to}`;
  }
}

/**
 * Local time by default, because an operator comparing a chart against a pager
 * knows what time it was where they are; the person's time display preference
 * (#214) can choose another zone or clock. The stored expression stays UTC
 * ISO-8601.
 */
export function formatInstant(
  date: Date,
  display: TimeDisplay = LOCAL_TIME_DISPLAY,
): string {
  return formatDateTime(date, display);
}

/** `Date` → the value an `<input type="datetime-local">` wants, on the display's clock. */
export function toLocalInput(
  date: Date,
  display: TimeDisplay = LOCAL_TIME_DISPLAY,
): string {
  return toZonedInput(date, display);
}

/** The inverse of {@link toLocalInput}; `null` for anything unparseable. */
export function fromLocalInput(
  value: string,
  display: TimeDisplay = LOCAL_TIME_DISPLAY,
): Date | null {
  return fromZonedInput(value, display);
}

/**
 * The window a URL asks for, or `fallback` when it asks for nothing or for
 * something the IR refuses. A bad `?from=` is a typo in a shared link, not an
 * error page — the dashboard's own range is the right answer for it.
 */
export function rangeFromParams(
  params: { from?: string | string[]; to?: string | string[] },
  fallback: TimeRange,
): TimeRange {
  const from = first(params.from);
  const to = first(params.to);
  if (from === undefined || to === undefined) return fallback;
  const parsed = TimeRange.safeParse({ from, to });
  return parsed.success ? parsed.data : fallback;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The query string for a window, or an empty string when it is the dashboard's
 * own — a shared link should not carry the default.
 */
export function rangeSearch(range: TimeRange, dashboardDefault: TimeRange): string {
  if (range.from === dashboardDefault.from && range.to === dashboardDefault.to) {
    return "";
  }
  return `?${new URLSearchParams({ from: range.from, to: range.to }).toString()}`;
}

/**
 * Vizzes whose x-axis is the panel's time field laid out left to right, and so
 * the ones where dragging across the chart means "this stretch of time".
 * `scatter` plots two numeric columns, `pie`/`donut` have no axis at all, and a
 * `heatmap`'s x categories are not necessarily ordered.
 */
const BRUSHABLE_VIZ = new Set(["line", "area", "bar"]);

/** Whether a brush over this panel can name a window. */
export function supportsTimeBrush(panel: Panel): boolean {
  return BRUSHABLE_VIZ.has(panel.viz) && panel.query.timeField !== undefined;
}

/**
 * A result-row value as an instant. Rows reach the browser through an SSE frame
 * that is `JSON.parse`d and never re-validated, so a timestamp arrives as
 * whatever the driver serialized — a string, usually — and anything else is
 * simply not a time.
 */
export function rowInstant(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The window a released brush selected: the timestamps of the first and last
 * rows it covered.
 *
 * Indices come from the chart's category axis, which is built from these same
 * rows in this same order, so they line up by construction. The result is
 * absolute — a brush names a stretch of history, which is the one thing a
 * relative expression cannot say.
 */
export function brushedRange(
  rows: Record<string, unknown>[],
  timeField: string | undefined,
  startIndex: number,
  endIndex: number,
): TimeRange | null {
  if (!timeField) return null;
  const first = Math.max(0, Math.min(startIndex, rows.length - 1));
  const last = Math.max(0, Math.min(endIndex, rows.length - 1));
  if (last <= first) return null;
  const from = rowInstant(rows[first]?.[timeField]);
  const to = rowInstant(rows[last]?.[timeField]);
  if (!from || !to) return null;
  return absoluteRange(from, to);
}
