import type { PanelData } from "@/components/charts/options";
import { readWindow } from "@/lib/panel-query";
import type { PollerEvent } from "@/lib/poller/registry";
import { readTruncation, type Truncation } from "@/lib/truncation";

/**
 * How a panel frame from the dashboard stream lands on what the browser holds.
 *
 * - `replace` swaps the window.
 * - `append` adds to it. When the frame says `since`, the rows it carries
 *   cover every timestamp from `since` on, so whatever the window holds from
 *   `since` on is dropped first. The newest bucket of a bucketed series is re-sent on every tick
 *   while it fills; this is what makes that an update rather than a
 *   duplicate, and what makes a resumed stream's overlap harmless (#43).
 *
 * Either way the window keeps the last `maxWindowPoints` rows, and says so in
 * `truncated` when that dropped any, as it carries a cut the server made
 * (#486).
 *
 * Timestamps compare as strings, as the server's cursor does: the query
 * client sends them as ISO 8601, which sorts lexically.
 *
 * The frame's window, when it says one, is the panel's own (#114) and is kept
 * with the rows; a chart that runs to "now" ends there.
 */
export function mergePanelRows(
  prev: PanelData | undefined,
  event: Extract<PollerEvent, { type: "panel" }>,
  maxWindowPoints: number,
): PanelData {
  const columns = event.columns.length ? event.columns : (prev?.columns ?? []);
  const window = readWindow(event.window) ?? prev?.window;
  const server = readTruncation(event.truncated);
  const finish = (rows: Record<string, unknown>[], truncated: Truncation | undefined) => {
    const data: PanelData = { columns, rows };
    if (window) data.window = window;
    if (truncated) data.truncated = truncated;
    return data;
  };
  if (event.mode === "replace" || !prev) {
    const fitted = fitToWindow(
      { columns, rows: event.rows, truncated: server },
      maxWindowPoints,
    );
    return finish(fitted.rows, fitted.truncated);
  }
  const { since, timeField } = event;
  const kept =
    since !== undefined && timeField
      ? prev.rows.filter((r) => String(r[timeField]) < since)
      : prev.rows;
  const rows = [...kept, ...event.rows];
  if (rows.length <= maxWindowPoints) return finish(rows, server);
  // The window is full and rolling: what it drops is the oldest. The total is
  // the one the last full result counted, which a rolling window keeps close to.
  return finish(rows.slice(-maxWindowPoints), {
    stage: "window",
    kept: maxWindowPoints,
    ...(prev.truncated?.total !== undefined ? { total: prev.truncated.total } : {}),
  });
}

/**
 * A whole result held to the point budget (#486): the newest
 * `maxWindowPoints` rows, saying so when that dropped any. A dashboard's full
 * replace and a chat panel go through this one function, so the same query
 * shows the same rows and the same badge in both.
 */
export function fitToWindow(
  result: { columns: string[]; rows: Record<string, unknown>[]; truncated?: Truncation },
  maxWindowPoints: number,
): { columns: string[]; rows: Record<string, unknown>[]; truncated?: Truncation } {
  const { rows } = result;
  const server = readTruncation(result.truncated);
  if (rows.length <= maxWindowPoints) {
    return server ? { ...result, truncated: server } : { columns: result.columns, rows };
  }
  // A server cut without a count (no time field) leaves the total unknown.
  const total = server ? server.total : rows.length;
  return {
    columns: result.columns,
    rows: rows.slice(-maxWindowPoints),
    truncated: {
      stage: "window",
      kept: maxWindowPoints,
      ...(total !== undefined ? { total } : {}),
    },
  };
}
