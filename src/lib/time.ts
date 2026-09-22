import type { TimeRange } from "@/lib/ir";

/**
 * Resolve an IR {@link TimeRange} (relative like `now-1h` or absolute ISO) into
 * concrete absolute Date bounds. The server is the SOLE authority on the time
 * window; the model never supplies time values.
 */

/**
 * A time expression or range the server refused to resolve.
 *
 * Typed rather than a bare `Error` so a caller can tell "the range you picked
 * is unusable" — the one part of a dashboard spec a viewer chooses, and so
 * theirs to fix — from an infrastructure failure that must stay opaque. The
 * message names only the expression it was handed.
 */
export class TimeRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeRangeError";
  }
}

const REL_RE = /^now(?:-(\d+)([smhdw]))?$/;

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

export function resolveTimeExpr(expr: string, now: Date = new Date()): Date {
  const rel = REL_RE.exec(expr);
  if (rel) {
    if (!rel[1]) return new Date(now);
    const amount = Number(rel[1]);
    const unit = rel[2];
    return new Date(now.getTime() - amount * UNIT_MS[unit]);
  }
  const d = new Date(expr);
  if (Number.isNaN(d.getTime())) {
    throw new TimeRangeError(`invalid time expression: ${expr}`);
  }
  return d;
}

export interface ResolvedRange {
  from: Date;
  to: Date;
}

export function resolveTimeRange(
  range: TimeRange,
  now: Date = new Date(),
): ResolvedRange {
  const from = resolveTimeExpr(range.from, now);
  const to = resolveTimeExpr(range.to, now);
  if (from.getTime() >= to.getTime()) {
    throw new TimeRangeError("time range `from` must be before `to`");
  }
  return { from, to };
}
