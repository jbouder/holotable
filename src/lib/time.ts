import { type TimeRange } from "@/lib/ir";

/**
 * Resolve an IR {@link TimeRange} (relative like `now-1h` or absolute ISO) into
 * concrete absolute Date bounds. The server is the SOLE authority on the time
 * window; the model never supplies time values.
 */

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
    throw new Error(`invalid time expression: ${expr}`);
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
    throw new Error("time range `from` must be before `to`");
  }
  return { from, to };
}
