import type { PanelData } from "@/components/charts/options";
import type { PollerEvent } from "@/lib/poller/registry";

/**
 * How a panel frame from the dashboard stream lands on what the browser holds.
 *
 * - `replace` swaps the window.
 * - `append` adds to it, keeping the newest `maxWindowPoints` rows. When the
 *   frame says `since`, the rows it carries cover every timestamp from
 *   `since` on, so whatever the window holds from `since` on is dropped
 *   first. The newest bucket of a bucketed series is re-sent on every tick
 *   while it fills; this is what makes that an update rather than a
 *   duplicate, and what makes a resumed stream's overlap harmless (#43).
 *
 * Timestamps compare as strings, as the server's cursor does: the query
 * client sends them as ISO 8601, which sorts lexically.
 */
export function mergePanelRows(
  prev: PanelData | undefined,
  event: Extract<PollerEvent, { type: "panel" }>,
  maxWindowPoints: number,
): PanelData {
  const columns = event.columns.length ? event.columns : (prev?.columns ?? []);
  if (event.mode === "replace" || !prev) {
    return { columns, rows: event.rows.slice(-maxWindowPoints) };
  }
  const { since, timeField } = event;
  const kept =
    since !== undefined && timeField
      ? prev.rows.filter((r) => String(r[timeField]) < since)
      : prev.rows;
  return { columns, rows: [...kept, ...event.rows].slice(-maxWindowPoints) };
}
