import { type ApiError, apiErrorFromThrown, readApiError } from "@/lib/errors";
import type { PanelQuery, TimeRange } from "@/lib/ir";

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
  plan: { sql: string; params: unknown[] };
  /** `sessionStatements(schema)` from the execution client. */
  session: string[];
  limits: { maxRows: number; statementTimeoutMs: number; maxResultBytes: number };
}): QueryPlanView {
  // The wrapper binds `from` then `to`, in that order, and only when there is
  // a time field. Anything else would be a change to `buildExecutablePlan`.
  const boundFrom = [input.timeRange.from, input.timeRange.to];
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

/** Parameters are instants; anything else is rendered rather than trusted. */
function instant(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export type PlanOutcome =
  | { ok: true; plan: QueryPlanView }
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
  init?: { signal?: AbortSignal },
): Promise<PlanOutcome> {
  try {
    const res = await fetch("/api/sql/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceId: query.sourceId,
        sql: query.sql,
        timeField: query.timeField,
        timeRange,
      }),
      signal: init?.signal,
    });
    if (!res.ok) return { ok: false, error: await readApiError(res) };
    return { ok: true, plan: (await res.json()) as QueryPlanView };
  } catch (err) {
    return { ok: false, error: apiErrorFromThrown(err) };
  }
}

/** "4,000 rows · 30 s · 4 MiB" — the limits line under a plan. */
export function summarizeLimits(plan: QueryPlanView): string {
  return [
    `${plan.maxRows.toLocaleString("en-US")} rows`,
    `${Math.round(plan.statementTimeoutMs / 1000)} s`,
    `${(plan.maxResultBytes / (1024 * 1024)).toFixed(1)} MiB`,
  ].join(" · ");
}
