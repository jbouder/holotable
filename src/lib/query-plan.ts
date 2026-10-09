import { isSqlQuery } from "@/lib/ir";
import { type ApiError, apiErrorFromThrown, readApiError } from "@/lib/errors";
import type { PanelQuery, TimeRange } from "@/lib/ir";
import type { VariableValues } from "@/lib/sql/variables";

/**
 * What the database is actually asked, as opposed to what the panel says.
 *
 * A panel's SQL is not the statement that runs. The server wraps it as
 * `SELECT * FROM (<inner>) AS _holo`, adds a `WHERE` on the declared
 * `timeField` bound to parameters it resolved itself, appends a `LIMIT`, and
 * runs the result inside a read-only transaction with a pinned `search_path`
 * and a statement timeout. None of that was visible anywhere, so the claim
 * that the server owns the time window (invariant 4) was something an author
 * had to take on faith.
 *
 * This is that claim, made checkable. Like `panelDetails()`, the shape is an
 * explicit allowlist rather than a projection of anything larger: a source is
 * referenced by its opaque id, and no host, port, database, user or
 * `secret_ref` has a field to travel in. `test/query-plan.test.ts` pins the
 * field set and feeds the builder deliberately leaky input.
 */

/** One bound parameter, and what the *server* bound it from. */
export interface PlanParam {
  /** `$1`, `$2` … as they appear in the statement. */
  placeholder: string;
  /** The value, as an ISO-8601 instant. */
  value: string;
  /** The expression the server resolved it from — `now-1h`, say. */
  from: string;
}

export interface QueryPlanView {
  /** The statement as the panel holds it. */
  sql: string;
  /** What the server sends, after wrapping and the row limit. */
  executedSql: string;
  /** Server-supplied, in statement order. Never model- or client-controlled. */
  params: PlanParam[];
  /** The output column the time filter is applied to, if any. */
  timeField?: string;
  /** The rows the statement is capped at. */
  maxRows: number;
  /** `statement_timeout` for the connection, in milliseconds. */
  statementTimeoutMs: number;
  /** Bytes after which the server stops collecting rows. */
  maxResultBytes: number;
  /** The session statements run before it, in order. */
  session: string[];
}

/**
 * Assemble the view. Takes the pieces rather than a `SourceRecord`, so a field
 * added to a source later cannot arrive here by being spread in.
 */
export function buildQueryPlanView(input: {
  sql: string;
  timeField?: string;
  /** What `resolveTimeRange` was given, for the "`now-1h` → instant" line. */
  timeRange: TimeRange;
  /** The plan `buildExecutablePlan` produced — its SQL and its parameters. */
  plan: { sql: string; params: unknown[]; variables?: string[] };
  /** `sessionStatements(schema)` from the execution client. */
  session: string[];
  limits: { maxRows: number; statementTimeoutMs: number; maxResultBytes: number };
  /** The claim the source's row filter binds, when it has one (#31). */
  rowFilterClaim?: string;
}): QueryPlanView {
  // The wrapper binds `from` then `to`, in that order, and only when there is
  // a time field; then the row filter's value, when the source has one.
  // Anything else would be a change to `buildExecutablePlan`.
  const boundFrom = [
    ...(input.timeField ? [input.timeRange.from, input.timeRange.to] : []),
    ...(input.rowFilterClaim ? [`your "${input.rowFilterClaim}" claim`] : []),
    // Variable values come last, in the plan's order (#67).
    ...(input.plan.variables ?? []).map((name) => `the :${name} selection`),
  ];
  return {
    sql: input.sql,
    executedSql: input.plan.sql,
    params: input.plan.params.map((value, i) => ({
      placeholder: `$${i + 1}`,
      value: instant(value),
      from: boundFrom[i] ?? "the server",
    })),
    timeField: input.timeField,
    maxRows: input.limits.maxRows,
    statementTimeoutMs: input.limits.statementTimeoutMs,
    maxResultBytes: input.limits.maxResultBytes,
    session: input.session,
  };
}

/**
 * What a Prometheus endpoint would be asked for a PromQL panel (#385): the
 * expression after the server's rewrites, and every parameter with what the
 * server resolved it from. An explicit field list, like {@link QueryPlanView}:
 * no URL, no auth mode, no header has a field to travel in.
 */
export interface PromqlPlanView {
  /** The expression as the panel holds it. */
  promql: string;
  /** What the server sends: variables bound, the tenant matcher spliced in. */
  executedPromql: string;
  /** `query` (one instant) or `query_range`. */
  endpoint: "query" | "query_range";
  /** `start`, `end` and `step`, or `time`: the server's, never the panel's. */
  params: { name: string; value: string; from: string }[];
  /** The deadline the endpoint and the request are both given, in milliseconds. */
  timeoutMs: number;
  /** Bytes after which the server stops reading the answer. */
  maxResultBytes: number;
  /** The most series a result may hold. */
  maxSeries: number;
  /** The most points per series a range query is stepped to. */
  maxPoints: number;
  /** Each variable the expression references, and the value bound for it. */
  variables: { name: string; value: string; from: string }[];
}

/** Either language's plan view; the field that holds the statement says which. */
export type AnyPlanView = QueryPlanView | PromqlPlanView;

/** Assemble the PromQL view from the plan and the pieces it was built from. */
export function buildPromqlPlanView(input: {
  promql: string;
  minStep?: string;
  timeRange: TimeRange;
  plan:
    | {
        instant: false;
        expr: string;
        start: Date;
        end: Date;
        stepSeconds: number;
        timeoutMs: number;
      }
    | { instant: true; expr: string; time: Date; timeoutMs: number };
  /** The claim the source's tenant label binds, when it has one (#31). */
  rowFilterClaim?: string;
  /** The variables the expression references, with the values the plan bound. */
  variables?: { name: string; value: string | readonly string[] }[];
  limits: {
    maxResultBytes: number;
    maxSeries: number;
    maxPoints: number;
    /** `PROMETHEUS_MIN_STEP_MS`: the step is never finer. */
    minStepMs: number;
  };
}): PromqlPlanView {
  const { plan, limits } = input;
  const stepFrom = [
    `the window ÷ ${limits.maxPoints.toLocaleString("en-US")} points`,
    `floored at ${seconds(limits.minStepMs)}`,
    ...(input.minStep ? [`and at the panel's minimum step of ${input.minStep}`] : []),
  ].join(", ");
  const params = plan.instant
    ? [{ name: "time", value: plan.time.toISOString(), from: input.timeRange.to }]
    : [
        {
          name: "start",
          value: plan.start.toISOString(),
          from: `${input.timeRange.from}, aligned to the step`,
        },
        {
          name: "end",
          value: plan.end.toISOString(),
          from: `${input.timeRange.to}, aligned to the step`,
        },
        {
          name: "step",
          value: `${plan.stepSeconds}s`,
          from: stepFrom,
        },
      ];
  return {
    promql: input.promql,
    executedPromql: plan.expr,
    endpoint: plan.instant ? "query" : "query_range",
    params: input.rowFilterClaim
      ? [
          ...params,
          {
            name: "tenant",
            value: "(your value)",
            from: `your "${input.rowFilterClaim}" claim`,
          },
        ]
      : params,
    timeoutMs: plan.timeoutMs,
    maxResultBytes: limits.maxResultBytes,
    maxSeries: limits.maxSeries,
    maxPoints: limits.maxPoints,
    variables: (input.variables ?? []).map(({ name, value }) => ({
      name,
      value: instant(value),
      from: `the :${name} selection`,
    })),
  };
}

/** "15 s", "1.5 s", "2 min": a duration the dialog states, from milliseconds. */
function seconds(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${Number((ms / 1000).toFixed(1))} s`;
}

/** Parameters are instants; anything else is rendered rather than trusted. */
function instant(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  // A multi-value variable is bound as an array (#67).
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

export type PlanOutcome =
  | { ok: true; plan: AnyPlanView }
  | { ok: false; error: ApiError };

/**
 * Ask the server what it would run. Nothing executes and nothing connects to
 * the source's database; a rejected statement comes back as a `400` carrying
 * the guard's own message, because there is no plan for SQL that would not be
 * accepted.
 */
export async function fetchQueryPlan(
  query: PanelQuery,
  timeRange: TimeRange,
  init?: { signal?: AbortSignal; variables?: VariableValues },
): Promise<PlanOutcome> {
  try {
    const res = await fetch("/api/sql/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceId: query.sourceId,
        // The query's own fields, named rather than spread (#388).
        ...(isSqlQuery(query)
          ? { sql: query.sql, timeField: query.timeField }
          : {
              promql: query.promql,
              ...(query.instant !== undefined ? { instant: query.instant } : {}),
              ...(query.minStep !== undefined ? { minStep: query.minStep } : {}),
            }),
        timeRange,
        ...(init?.variables ? { variables: init.variables } : {}),
      }),
      signal: init?.signal,
    });
    if (!res.ok) return { ok: false, error: await readApiError(res) };
    return { ok: true, plan: (await res.json()) as AnyPlanView };
  } catch (err) {
    return { ok: false, error: apiErrorFromThrown(err) };
  }
}

/** Whether a plan view is PromQL's: the field that holds the statement says. */
export function isPromqlPlanView(plan: AnyPlanView): plan is PromqlPlanView {
  return "promql" in plan;
}

/**
 * "4,000 rows · 30 s · 4.0 MiB" under a SQL plan; "1,000 points · 30 s ·
 * 4.0 MiB · 100 series" under a PromQL one.
 */
export function summarizeLimits(plan: AnyPlanView): string {
  if (isPromqlPlanView(plan)) {
    return [
      `${plan.maxPoints.toLocaleString("en-US")} points`,
      `${Math.round(plan.timeoutMs / 1000)} s`,
      `${(plan.maxResultBytes / (1024 * 1024)).toFixed(1)} MiB`,
      `${plan.maxSeries.toLocaleString("en-US")} series`,
    ].join(" · ");
  }
  return [
    `${plan.maxRows.toLocaleString("en-US")} rows`,
    `${Math.round(plan.statementTimeoutMs / 1000)} s`,
    `${(plan.maxResultBytes / (1024 * 1024)).toFixed(1)} MiB`,
  ].join(" · ");
}
