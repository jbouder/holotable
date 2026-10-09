import { isSqlQuery, queryText, queryTimeField } from "@/lib/ir";
import { type ApiError, apiErrorFromThrown, readApiError } from "@/lib/errors";
import type { PanelQuery, TimeRange } from "@/lib/ir";
import type { VariableValues } from "@/lib/sql/variables";
import { valuesKey } from "@/lib/variable-selection";

/**
 * The client half of running one guarded query.
 *
 * Three surfaces run a panel's SQL before it is live — the editor's Run
 * preview, the create/edit preview grid, and Explore — and all three must send
 * the same thing: an opaque `sourceId`, the statement, the declared `timeField`
 * and a *relative* time range the server resolves. Writing that request once
 * keeps invariants 4 and 5 in a single place instead of in three fetch calls
 * that can quietly diverge.
 */

export interface QueryRows {
  columns: string[];
  rows: Record<string, unknown>[];
  /** The window the server resolved for these rows, in epoch ms. */
  window?: { from: number; to: number };
}

export const EMPTY_ROWS: QueryRows = { columns: [], rows: [] };

/**
 * What `/api/query` is sent — an explicit allowlist, like `panelDetails()`.
 * A panel carries a title, a layout and a viz that the executor has no use
 * for, and a spread of `panel.query` would ship whatever is added to it next.
 */
export type QueryRequest = (
  | { sourceId: string; sql: string; timeField?: string }
  | { sourceId: string; promql: string; instant?: boolean; minStep?: string }
) & {
  timeRange: TimeRange;
  /** The dashboard's variables, as the preview binds them (#67). */
  variables?: VariableValues;
};

/** The query's own fields, named one by one rather than spread. */
function queryFields(query: PanelQuery) {
  return isSqlQuery(query)
    ? { sourceId: query.sourceId, sql: query.sql, timeField: query.timeField }
    : {
        sourceId: query.sourceId,
        promql: query.promql,
        instant: query.instant,
        minStep: query.minStep,
      };
}

export function queryRequest(
  query: PanelQuery,
  timeRange: TimeRange,
  variables?: VariableValues,
): QueryRequest {
  return {
    ...queryFields(query),
    timeRange,
    ...(variables && Object.keys(variables).length > 0 ? { variables } : {}),
  };
}

export type PanelQueryOutcome =
  | { ok: true; rows: QueryRows; elapsedMs: number }
  | { ok: false; error: ApiError; elapsedMs: number };

/**
 * Execute one panel query. The elapsed time is the caller's round trip, not the
 * server's execution time — it is what the author is waiting for, and it needs
 * no new field on the response.
 */
export async function runPanelQuery(
  query: PanelQuery,
  timeRange: TimeRange,
  init?: { signal?: AbortSignal; variables?: VariableValues },
): Promise<PanelQueryOutcome> {
  const startedAt = performance.now();
  const elapsed = () => Math.round(performance.now() - startedAt);
  try {
    const res = await fetch("/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(queryRequest(query, timeRange, init?.variables)),
      signal: init?.signal,
    });
    if (!res.ok) {
      return { ok: false, error: await readApiError(res), elapsedMs: elapsed() };
    }
    return { ok: true, rows: readRows(await res.json()), elapsedMs: elapsed() };
  } catch (err) {
    return { ok: false, error: apiErrorFromThrown(err), elapsedMs: elapsed() };
  }
}

/** A result body is trusted no further than its shape. */
function readRows(body: unknown): QueryRows {
  const record = typeof body === "object" && body !== null ? body : {};
  const { columns, rows, window } = record as Partial<QueryRows>;
  const resolved = readWindow(window);
  return {
    columns: Array.isArray(columns) ? columns : [],
    rows: Array.isArray(rows) ? rows : [],
    ...(resolved && { window: resolved }),
  };
}

/** A window from a response, or undefined when it is not two finite instants. */
export function readWindow(value: unknown): QueryRows["window"] {
  if (typeof value !== "object" || value === null) return undefined;
  const { from, to } = value as { from?: unknown; to?: unknown };
  return typeof from === "number" &&
    typeof to === "number" &&
    Number.isFinite(from) &&
    Number.isFinite(to)
    ? { from, to }
    : undefined;
}

/**
 * What a verdict is an answer to.
 *
 * A verdict outlives the press that produced it, so it has to say what question
 * it answered: an editor that kept showing "valid" after the source changed, or
 * a preview still labelled current after the time range moved, would be showing
 * a verdict nobody reached. Whoever holds one holds its subject alongside it and
 * retires the verdict when the subject stops matching.
 *
 * The two differ, and collapsing them would be wrong in both directions. A
 * check is `validateSql`, which reads the statement and the source's catalog
 * and nothing else. A run also depends on the time field it filters on and the
 * window the server resolves — so a check survives a time-range change and a
 * result does not.
 *
 * Serialized rather than joined on a separator, so no pair of values can be
 * arranged to collide with another.
 */
export function checkSubject(query: PanelQuery, variables: VariableValues = {}): string {
  return JSON.stringify([
    query.sourceId,
    queryText(query),
    Object.keys(variables).sort(),
  ]);
}

export function runSubject(
  query: PanelQuery,
  timeRange: TimeRange,
  variables: VariableValues = {},
): string {
  return JSON.stringify([
    query.sourceId,
    queryText(query),
    queryTimeField(query) ?? null,
    timeRange.from,
    timeRange.to,
    valuesKey(variables),
    // What else changes a PromQL result: the step's floor (#383).
    ...(isSqlQuery(query) ? [] : [query.minStep ?? null]),
  ]);
}

export type SqlCheck = { ok: true } | { ok: false; error: ApiError };

/**
 * Ask the server whether a statement would be accepted.
 *
 * A rejection arrives as a `200` body, so it is turned into a `statement`
 * error here: the guard's message names the table or function it refused and
 * the fix is to edit the query — the same presentation a failed execution
 * gets. A transport failure stays whatever `readApiError` made of it.
 */
export async function validatePanelSql(input: {
  sourceId: string;
  sql: string;
  /** The variables the dashboard declares (#67). */
  variables?: readonly string[];
}): Promise<SqlCheck> {
  try {
    const res = await fetch("/api/sql/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceId: input.sourceId,
        sql: input.sql,
        ...(input.variables?.length ? { variables: input.variables } : {}),
      }),
    });
    if (!res.ok) return { ok: false, error: await readApiError(res) };
    const body: unknown = await res.json();
    const record = (typeof body === "object" && body !== null ? body : {}) as Record<
      string,
      unknown
    >;
    if (record.ok === true) return { ok: true };
    const message =
      typeof record.error === "string" && record.error ? record.error : "invalid sql";
    return { ok: false, error: { error: message, kind: "statement" } };
  } catch (err) {
    return { ok: false, error: apiErrorFromThrown(err) };
  }
}

/** "1 row in 312 ms" — the line under a preview result. */
export function summarizeResult(rowCount: number, elapsedMs: number): string {
  const rows = `${rowCount} ${rowCount === 1 ? "row" : "rows"}`;
  return `${rows} in ${formatElapsed(elapsedMs)}`;
}

export function formatElapsed(elapsedMs: number): string {
  if (elapsedMs < 1000) return `${Math.round(elapsedMs)} ms`;
  return `${(elapsedMs / 1000).toFixed(1)} s`;
}
