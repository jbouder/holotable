import { config } from "@/lib/config";
import { durationMs } from "@/lib/promql/parse";
import {
  applyPromqlRowFilter,
  type PromqlRowFilterBinding,
} from "@/lib/promql/row-filter";
import { regexLiteral, stringLiteral } from "@/lib/promql/parse";
import {
  defaultLimits,
  type PromqlCatalog,
  type PromqlLimits,
} from "@/lib/promql/safety";
import { bindPromqlVariables } from "@/lib/promql/variables";
import type { VariableValues } from "@/lib/sql/variables";

/**
 * What a PromQL panel asks the endpoint (#384), as `ExecutablePlan` is for
 * SQL: the expression after the server's rewrites, and the parameters the
 * executor sends. Every time in it is the server's: the window it resolved,
 * and the step it chose for that window. The expression carries none.
 *
 * Built only from an expression `validatePromql` accepted. Phase 4 (#385)
 * sends it; the arithmetic of the step lives here so the plan dialog and the
 * executor read one answer.
 */
export type PromqlPlan =
  | {
      instant: false;
      expr: string;
      /** `query_range`'s `start`, `end` and `step`. */
      start: Date;
      end: Date;
      stepSeconds: number;
      timeoutMs: number;
    }
  | {
      instant: true;
      expr: string;
      /** `query`'s `time`: the end of the window. */
      time: Date;
      timeoutMs: number;
    };

/**
 * The step for a window (#385): enough points to draw it and no more than
 * `PROMQL_MAX_POINTS` per series, never under `PROMETHEUS_MIN_STEP_MS`, and
 * raised to the panel's `minStep` when it asks for a coarser one. Whole
 * seconds, so the window can be aligned to it.
 */
export function stepSecondsFor(from: Date, to: Date, minStep?: string): number {
  const spanMs = Math.max(1, to.getTime() - from.getTime());
  const floorMs = minStep ? (durationMs(minStep) ?? 0) : 0;
  const stepMs = Math.max(
    floorMs,
    config.prometheusMinStepMs,
    Math.ceil(spanMs / Math.max(1, config.promqlMaxPoints)),
    1_000,
  );
  return Math.ceil(stepMs / 1_000);
}

/**
 * The window aligned down to a multiple of the step, so two polls a few
 * seconds apart ask for the same points and a chart's x values do not drift.
 */
export function alignToStep(at: Date, stepSeconds: number): Date {
  const stepMs = stepSeconds * 1_000;
  return new Date(Math.floor(at.getTime() / stepMs) * stepMs);
}

export function buildPromqlPlan(input: {
  promql: string;
  instant?: boolean;
  minStep?: string;
  from: Date;
  to: Date;
  /** The viewer's tenant matcher, when the source filters by one (#31). */
  rowFilter: PromqlRowFilterBinding | null;
  /** Values already checked against what the dashboard allows (#67). */
  variables?: VariableValues;
  limits?: PromqlLimits;
}): PromqlPlan {
  const limits = input.limits ?? defaultLimits();
  let expr = bindPromqlVariables(input.promql.trim(), input.variables ?? {}, limits);
  if (input.rowFilter) expr = applyPromqlRowFilter(expr, input.rowFilter, limits);
  const timeoutMs = config.queryTimeoutSeconds * 1_000;
  if (input.instant) return { instant: true, expr, time: input.to, timeoutMs };
  const stepSeconds = stepSecondsFor(input.from, input.to, input.minStep);
  const start = alignToStep(input.from, stepSeconds);
  const end = alignToStep(input.to, stepSeconds);
  return {
    instant: false,
    expr,
    start,
    end: end < start ? start : end,
    stepSeconds,
    timeoutMs,
  };
}

/**
 * What a label-values variable asks the endpoint (`/api/v1/label/<label>/values`):
 * the label, and the `match[]` selectors its values are drawn from, each
 * with the viewer's tenant matcher. Without a `match` of its own, the values
 * come from the allowlisted metrics and nothing else: the endpoint would
 * otherwise answer from every series it has.
 *
 * Built only from a query `validatePromqlLabelValues` accepted.
 */
export interface LabelValuesPlan {
  label: string;
  match: string[];
  timeoutMs: number;
}

export function buildLabelValuesPlan(input: {
  label: string;
  match?: string;
  catalog: PromqlCatalog;
  rowFilter: PromqlRowFilterBinding | null;
  limits?: PromqlLimits;
}): LabelValuesPlan {
  const limits = input.limits ?? defaultLimits();
  const timeoutMs = config.queryTimeoutSeconds * 1_000;
  const filter = input.rowFilter;
  if (input.match !== undefined) {
    const own = input.match.trim();
    return {
      label: input.label,
      match: [filter ? applyPromqlRowFilter(own, filter, limits) : own],
      timeoutMs,
    };
  }
  // The server's own selector over the allowlist. The guard refuses a
  // `__name__` pattern from an author, so it is not run through the guard's
  // rewrite; the tenant matcher is appended to it directly.
  const names = input.catalog.metrics.map((m) => regexLiteral(m.name)).join("|");
  const allowlist = `__name__=~${stringLiteral(`^(${names})$`)}`;
  if (filter && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(filter.label)) {
    throw new Error(`PromQL row filter: "${filter.label}" cannot be a tenant label`);
  }
  const tenant = filter ? `, ${filter.label}=${stringLiteral(filter.value)}` : "";
  return { label: input.label, match: [`{${allowlist}${tenant}}`], timeoutMs };
}
