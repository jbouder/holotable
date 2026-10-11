import type { PanelData } from "@/components/charts/options";
import type { ApiError } from "@/lib/errors";
import type { PollerEvent } from "@/lib/poller/registry";
import { mergePanelRows } from "@/lib/stream-merge";

export type PanelStatus =
  | "loading"
  | "live"
  | "stale"
  | "error"
  | "degraded"
  | "tombstoned";

export interface PanelState {
  data: PanelData;
  status: PanelStatus;
  error?: ApiError;
  /**
   * When this panel's data last arrived. Panels go stale independently — one
   * failing query does not stop the others — so the dashboard-wide "updated Ns
   * ago" is not the answer for any individual panel.
   */
  updatedAt?: number;
  /**
   * A `degraded` panel (#44): how many times it has failed in a row, and when
   * the server tries it next. `retrying` is set while a viewer's "Retry now"
   * waits for the result, which replaces the whole state when it arrives.
   */
  failures?: number;
  retryAt?: number;
  retrying?: boolean;
}

export type PanelStates = Record<string, PanelState>;

const NO_ROWS: PanelData = { columns: [], rows: [] };

/**
 * A panel that was live is now only as fresh as its last frame. Used on a
 * transport error, on the server's drain frame, and by the watchdog.
 *
 * `updatedAt` is deliberately left alone: it records when the data arrived, and
 * going stale does not change that. It is what the panel's tooltip reports.
 * A panel that was not live keeps its state object, so it does not re-render.
 */
export function markStale(prev: PanelStates): PanelStates {
  if (!Object.values(prev).some((v) => v.status === "live")) return prev;
  const out: PanelStates = {};
  for (const [k, v] of Object.entries(prev)) {
    out[k] = v.status === "live" ? { ...v, status: "stale" } : v;
  }
  return out;
}

/** One panel's next state after one frame, or `cur` for a frame about none. */
function applyOne(
  cur: PanelState | undefined,
  event: Extract<PollerEvent, { panelId: string }>,
  maxWindowPoints: number,
  at: number,
): PanelState {
  const data = cur?.data ?? NO_ROWS;
  switch (event.type) {
    case "panel-error":
      return {
        data,
        status: "error",
        error: { error: event.error, kind: event.kind },
        updatedAt: cur?.updatedAt,
      };
    case "panel-degraded":
      return {
        data,
        status: "degraded",
        error: { error: event.error, kind: event.kind },
        failures: event.failures,
        retryAt: event.retryAt,
        updatedAt: cur?.updatedAt,
      };
    case "tombstone":
      return { data, status: "tombstoned", updatedAt: cur?.updatedAt };
    case "panel":
      return {
        data: mergePanelRows(cur?.data, event, maxWindowPoints),
        status: "live",
        updatedAt: at,
      };
  }
}

/**
 * Apply a batch of stream frames in one step (#485).
 *
 * The poller sends a tick's frames together, and the browser used to apply
 * each as its own state update, so every frame re-rendered every panel. A
 * batch is one new object, and a panel no frame in it names keeps its state
 * by reference: that identity is what lets a memoized `PanelView` skip it.
 * A batch that names no panel returns `prev` itself, so it renders nothing.
 */
export function applyPollerEvents(
  prev: PanelStates,
  events: readonly PollerEvent[],
  maxWindowPoints: number,
  at: number,
): PanelStates {
  let next: PanelStates | null = null;
  for (const event of events) {
    // Neither carries a panel id: a tick is freshness, a dashboard error is
    // handled by the caller and shown above the grid.
    if (event.type === "tick" || event.type === "dashboard-error") continue;
    const base: PanelStates = next ?? prev;
    next ??= { ...prev };
    next[event.panelId] = applyOne(base[event.panelId], event, maxWindowPoints, at);
  }
  return next ?? prev;
}
