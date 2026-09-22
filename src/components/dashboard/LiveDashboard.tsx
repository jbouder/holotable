"use client";

import * as React from "react";
import { Pause, Play } from "lucide-react";
import type { Dashboard, TimeRange } from "@/lib/ir";
import type { PollerEvent } from "@/lib/poller/registry";
import { DashboardGrid } from "@/components/dashboard/DashboardGrid";
import { PanelView, type PanelState } from "@/components/dashboard/PanelView";
import { ErrorDisplay } from "@/components/ui/error-display";
import type { ApiError } from "@/lib/errors";
import { ConnectionIndicator } from "@/components/dashboard/ConnectionIndicator";
import type { PanelData } from "@/components/charts/options";
import { Button } from "@/components/ui/button";
import { TimeRangeFilter } from "@/components/dashboard/TimeRangeFilter";
import {
  type ConnectionSignal,
  type ConnectionStatus,
  INITIAL_CONNECTION,
  reduceConnection,
} from "@/lib/connection";
import { DRAIN_EVENT } from "@/lib/sse";

/**
 * A panel that was live is now only as fresh as its last frame. Used on a
 * transport error, on the server's drain frame, and by the watchdog.
 *
 * `updatedAt` is deliberately left alone: it records when the data arrived, and
 * going stale does not change that. It is what the panel's tooltip reports.
 */
function markStale(prev: Record<string, PanelState>): Record<string, PanelState> {
  const out: Record<string, PanelState> = {};
  for (const [k, v] of Object.entries(prev)) {
    out[k] = v.status === "live" ? { ...v, status: "stale" } : v;
  }
  return out;
}

/**
 * Live dashboard viewer.
 *
 * Opens exactly ONE EventSource for the whole dashboard (SSE authenticated via
 * the session cookie, sent automatically for same-origin requests) and fans
 * events out to per-panel state. Appended deltas are merged into a bounded
 * rolling window; PanelView applies them via ECharts setOption without
 * recreating charts. A panel becomes "stale" if no tick arrives within roughly
 * two refresh intervals.
 *
 * Connection state is tracked separately from panel state, in the reducer in
 * `lib/connection.ts`: `EventSource` retries forever and says nothing, so
 * without it a dead stream and a paused one are the same grey dot.
 */
export function LiveDashboard({
  dashboardId,
  spec,
  maxWindowPoints,
  header,
  actions,
  empty,
}: {
  dashboardId: string;
  spec: Dashboard;
  maxWindowPoints: number;
  header?: React.ReactNode;
  actions?: React.ReactNode;
  /** Shown in place of the grid when the spec carries no panels. */
  empty?: React.ReactNode;
}) {
  const [states, setStates] = React.useState<Record<string, PanelState>>({});
  const [live, setLive] = React.useState(true);
  const [timeRange, setTimeRange] = React.useState<TimeRange>(spec.timeRange);
  const [connection, setConnection] =
    React.useState<ConnectionStatus>(INITIAL_CONNECTION);
  // A failure of the whole cycle rather than of one panel — an unresolvable
  // time range, typically. It belongs above the grid because it is not any one
  // panel's, and it clears on the next completed tick.
  const [dashboardError, setDashboardError] = React.useState<ApiError | null>(null);
  // Bumped by the manual Reconnect to tear the EventSource down and build a
  // new one; the browser's own retry schedule is not something a page can
  // shortcut, so the socket has to be replaced rather than nudged.
  const [reconnectNonce, setReconnectNonce] = React.useState(0);
  const lastTickRef = React.useRef<number>(0);
  const streamUrl = React.useMemo(() => {
    const params = new URLSearchParams(timeRange);
    return `/api/dashboards/${dashboardId}/stream?${params.toString()}`;
  }, [dashboardId, timeRange]);

  const signal = React.useCallback((s: ConnectionSignal) => {
    setConnection((prev) => reduceConnection(prev, s));
  }, []);

  const applyEvent = React.useCallback(
    (event: PollerEvent, at: number) => {
      setStates((prev) => {
        // Neither carries a panel id: a tick is freshness, a dashboard error is
        // handled by the caller and shown above the grid.
        if (event.type === "tick" || event.type === "dashboard-error") return prev;
        const cur = prev[event.panelId];
        if (event.type === "panel-error") {
          return {
            ...prev,
            [event.panelId]: {
              data: cur?.data ?? { columns: [], rows: [] },
              status: "error",
              error: { error: event.error, kind: event.kind },
              updatedAt: cur?.updatedAt,
            },
          };
        }
        if (event.type === "tombstone") {
          return {
            ...prev,
            [event.panelId]: {
              data: cur?.data ?? { columns: [], rows: [] },
              status: "tombstoned",
              updatedAt: cur?.updatedAt,
            },
          };
        }
        // event.type === "panel"
        const next = mergeData(cur?.data, event, maxWindowPoints);
        return {
          ...prev,
          [event.panelId]: { data: next, status: "live", updatedAt: at },
        };
      });
    },
    [maxWindowPoints],
  );

  // `reconnectNonce` is listed as a dependency but never read in the body —
  // changing it is the whole point. Re-running this effect is the only way to
  // replace an EventSource, whose own retry schedule a page cannot reach.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the nonce exists to force a fresh EventSource
  React.useEffect(() => {
    if (!live) return;
    lastTickRef.current = Date.now();
    const es = new EventSource(streamUrl);
    es.onopen = () => {
      setStates({});
      setDashboardError(null);
      signal({ type: "open" });
    };
    es.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as PollerEvent;
        if (event.type === "tick") {
          lastTickRef.current = event.at;
          // A tick only arrives on a completed cycle, so it is also the signal
          // that whatever broke the last one is over.
          setDashboardError(null);
          signal({ type: "tick", at: event.at });
        }
        if (event.type === "dashboard-error") {
          setDashboardError({ error: event.error, kind: event.kind });
          // The stream is healthy, the data behind it is not: every panel is
          // now only as fresh as its last frame, so say so rather than leave a
          // live badge over frozen charts.
          setStates(markStale);
        }
        applyEvent(event, Date.now());
      } catch {
        /* ignore malformed frame */
      }
    };
    es.onerror = () => {
      // Mark everything stale on transport error. `readyState === CLOSED` is
      // the browser saying it will NOT retry — an expired session on the
      // stream route, typically — which is the one case a manual Reconnect
      // cannot fix by itself but must still be distinguishable from a retry
      // already in flight.
      setStates(markStale);
      signal({ type: "error", closed: es.readyState === EventSource.CLOSED });
    };
    // The server sends this just before it stops, along with an SSE `retry:`
    // hint that EventSource honours: the reconnect lands on a healthy instance
    // after a spread-out delay, so say "stale" now rather than wait out the
    // watchdog.
    const onDraining = () => {
      setStates(markStale);
      signal({ type: "error", closed: false });
    };
    es.addEventListener(DRAIN_EVENT, onDraining);
    return () => {
      es.removeEventListener(DRAIN_EVENT, onDraining);
      es.close();
    };
  }, [applyEvent, live, signal, streamUrl, reconnectNonce]);

  // Staleness watchdog. Disabled while paused — a paused dashboard is not stale.
  React.useEffect(() => {
    if (!live) return;
    const budget = Math.max(spec.refreshIntervalMs * 2, 6_000);
    const id = setInterval(() => {
      if (Date.now() - lastTickRef.current > budget) {
        setStates(markStale);
      }
    }, budget);
    return () => clearInterval(id);
  }, [spec.refreshIntervalMs, live]);

  // Read `live` directly rather than from a `setLive` updater: the updater can
  // run twice under StrictMode, and signalling the reducer from inside it would
  // count the pause twice.
  function togglePause() {
    signal({ type: live ? "pause" : "resume" });
    setLive(!live);
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        {header}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <ConnectionIndicator
            status={connection}
            onReconnect={() => setReconnectNonce((n) => n + 1)}
          />
          <TimeRangeFilter value={timeRange} onChange={setTimeRange} />
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={!live}
            aria-label={live ? "Pause live updates" : "Resume live updates"}
            className="text-muted hover:text-foreground"
            onClick={togglePause}
          >
            {live ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            {live ? "Pause" : "Resume"}
          </Button>
          {actions}
        </div>
      </div>

      {dashboardError && <ErrorDisplay error={dashboardError} className="mb-4" />}

      <DashboardGrid
        panels={spec.panels}
        empty={empty}
        renderPanel={(panel) => (
          <PanelView panel={panel} state={states[panel.id]} paused={!live} />
        )}
      />
    </div>
  );
}

function mergeData(
  prev: PanelData | undefined,
  event: Extract<PollerEvent, { type: "panel" }>,
  maxWindowPoints: number,
): PanelData {
  if (event.mode === "replace" || !prev) {
    return {
      columns: event.columns.length ? event.columns : (prev?.columns ?? []),
      rows: event.rows.slice(-maxWindowPoints),
    };
  }
  const rows = [...prev.rows, ...event.rows];
  return {
    columns: event.columns.length ? event.columns : prev.columns,
    rows: rows.slice(-maxWindowPoints),
  };
}
