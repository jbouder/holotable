import { config } from "@/lib/config";
import { applyLogqlRowFilter, type LogqlRowFilterBinding } from "@/lib/logql/row-filter";
import {
  analyzeLogql,
  checkAnchors,
  defaultLogqlLimits,
  type LogqlCatalog,
  type LogqlKind,
  type LogqlLimits,
  LogqlRefusal,
} from "@/lib/logql/safety";
import { bindLogqlVariables } from "@/lib/logql/variables";
import { stringLiteral } from "@/lib/promql/parse";
import { alignToStep, finestPointsFor, stepSecondsFor } from "@/lib/promql/plan";
import { RowFilterError } from "@/lib/sql/row-filter";
import type { VariableValues } from "@/lib/sql/variables";

/**
 * What a LogQL panel asks the endpoint (#561), as `PromqlPlan` is for
 * PromQL: the expression after the server's rewrites, and the parameters the
 * executor sends. Every time in it is the server's; the expression carries
 * none.
 *
 * A **log** query is a `query_range` over the window, newest lines first,
 * at most `MAX_QUERY_ROWS` of them: the row cap, which keeps the newest
 * rows. A **metric** query is a `query_range` at a step, with the same step
 * arithmetic, point budget and alignment as PromQL (`promql/plan.ts`), or a
 * `query` at the end of the window when the panel is instant. Loki runs a
 * log query only over a range, so an instant log query is refused here.
 *
 * Built only from an expression `validateLogql` accepted. Phase 3 (#562)
 * sends it.
 */
export type LogqlPlan =
  | {
      kind: "log";
      instant: false;
      expr: string;
      /** `query_range`'s `start` and `end`: the window, as resolved. */
      start: Date;
      end: Date;
      /** `query_range`'s `limit`: the most lines the endpoint returns. */
      limit: number;
      /** `query_range`'s `direction`: newest first, so the cap keeps the newest. */
      direction: "backward";
      timeoutMs: number;
    }
  | {
      kind: "metric";
      instant: false;
      expr: string;
      /** `query_range`'s `start`, `end` and `step`, aligned to the step. */
      start: Date;
      end: Date;
      stepSeconds: number;
      timeoutMs: number;
      /**
       * Set when `PROMQL_MAX_POINTS` widened the step (#486): how many points
       * the finest step the panel allows would have drawn over the window.
       */
      finestPoints?: number;
    }
  | {
      kind: "metric";
      instant: true;
      expr: string;
      /** `query`'s `time`: the end of the window. */
      time: Date;
      timeoutMs: number;
    };

export function buildLogqlPlan(input: {
  logql: string;
  instant?: boolean;
  minStep?: string;
  from: Date;
  to: Date;
  /** The source's label allowlist: what every selector is anchored on. */
  catalog: LogqlCatalog;
  /** The viewer's tenant matcher, when the source filters by one (#31). */
  rowFilter: LogqlRowFilterBinding | null;
  /** Values already checked against what the dashboard allows (#67). */
  variables?: VariableValues;
  limits?: LogqlLimits;
}): LogqlPlan {
  const limits = input.limits ?? defaultLogqlLimits();
  let expr = bindLogqlVariables(input.logql.trim(), input.variables ?? {}, limits);
  // A bound value may have emptied the matcher a selector was anchored on
  // (`env=""` matches the streams without the label): check again.
  const bound = analyzeLogql(expr, "bound", limits);
  checkAnchors(expr, bound.selectors, input.catalog);
  if (input.rowFilter) {
    expr = applyLogqlRowFilter(expr, input.rowFilter, input.catalog, limits);
  }
  const kind: LogqlKind = bound.kind;
  const timeoutMs = config.queryTimeoutSeconds * 1_000;
  if (kind === "log") {
    if (input.instant) {
      throw new LogqlRefusal(
        "structure",
        "a log query runs over the dashboard's range; it cannot be an instant query",
      );
    }
    return {
      kind,
      instant: false,
      expr,
      start: input.from,
      end: input.to < input.from ? input.from : input.to,
      limit: config.maxQueryRows,
      direction: "backward",
      timeoutMs,
    };
  }
  if (input.instant) return { kind, instant: true, expr, time: input.to, timeoutMs };
  const stepSeconds = stepSecondsFor(input.from, input.to, input.minStep);
  const start = alignToStep(input.from, stepSeconds);
  const end = alignToStep(input.to, stepSeconds);
  const finestPoints = finestPointsFor(input.from, input.to, input.minStep);
  return {
    kind,
    instant: false,
    expr,
    start,
    end: end < start ? start : end,
    stepSeconds,
    timeoutMs,
    ...(finestPoints !== undefined ? { finestPoints } : {}),
  };
}

/**
 * What a label-values variable asks a Loki source
 * (`/loki/api/v1/label/<label>/values`): the label, which the catalog lists,
 * and the stream selector its values are drawn from, with the viewer's
 * tenant matcher. Without a `match` of its own and without a tenant, there
 * is no `query`: the label is on the allowlist, and its values are the
 * label's, from every stream the endpoint holds in the window.
 *
 * Built only from a query `validateLogqlLabelValues` accepted. The window
 * is the executor's, as for PromQL: the last `LOGQL_MAX_RANGE`.
 */
export interface LogqlLabelValuesPlan {
  label: string;
  query?: string;
  timeoutMs: number;
}

export function buildLogqlLabelValuesPlan(input: {
  label: string;
  match?: string;
  catalog: LogqlCatalog;
  rowFilter: LogqlRowFilterBinding | null;
  limits?: LogqlLimits;
}): LogqlLabelValuesPlan {
  const limits = input.limits ?? defaultLogqlLimits();
  const timeoutMs = config.queryTimeoutSeconds * 1_000;
  const filter = input.rowFilter;
  if (input.match !== undefined) {
    const own = input.match.trim();
    return {
      label: input.label,
      query: filter ? applyLogqlRowFilter(own, filter, input.catalog, limits) : own,
      timeoutMs,
    };
  }
  if (!filter) return { label: input.label, timeoutMs };
  // The tenant alone is a selector: a listed label, `=`, and a value, so it
  // is anchored. Written as the row filter writes it, through its checks.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(filter.label) || filter.label.startsWith("__")) {
    throw new Error(`LogQL row filter: "${filter.label}" cannot be a tenant label`);
  }
  if (!input.catalog.labels.some((l) => l.name === filter.label)) {
    throw new RowFilterError(
      `this source filters by "${filter.label}", which its catalog does not list`,
    );
  }
  if (filter.value === "")
    throw new RowFilterError(`no value to filter "${filter.label}" by`);
  const query = `{${filter.label}=${stringLiteral(filter.value)}}`;
  checkAnchors(query, analyzeLogql(query, "bound", limits).selectors, input.catalog);
  return { label: input.label, query, timeoutMs };
}
