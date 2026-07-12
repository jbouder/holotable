"use client";

import * as React from "react";
import { Pause, Play } from "lucide-react";
import type { Dashboard, TimeRange } from "@/lib/ir";
import type { PollerEvent } from "@/lib/poller/registry";
import { DashboardGrid } from "@/components/dashboard/DashboardGrid";
import { PanelView, type PanelState } from "@/components/dashboard/PanelView";
import type { PanelData } from "@/components/charts/options";
import { Button } from "@/components/ui/button";
import { TimeRangeFilter } from "@/components/dashboard/TimeRangeFilter";
import { cn } from "@/lib/utils";

/**
 * Live dashboard viewer.
 *
 * Opens exactly ONE EventSource for the whole dashboard (SSE authenticated via
 * the session cookie, sent automatically for same-origin requests) and fans
 * events out to per-panel state. Appended deltas are merged into a bounded
 * rolling window; PanelView applies them via ECharts setOption without
 * recreating charts. A panel becomes "stale" if no tick arrives within roughly
 * two refresh intervals.
 */
export function LiveDashboard({
  dashboardId,
  spec,
  maxWindowPoints,
  header,
  actions,
}: {
  dashboardId: string;
  spec: Dashboard;
  maxWindowPoints: number;
  header?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const [states, setStates] = React.useState<Record<string, PanelState>>({});
  const [live, setLive] = React.useState(true);
  const [timeRange, setTimeRange] = React.useState<TimeRange>(spec.timeRange);
  const lastTickRef = React.useRef<number>(0);
  const streamUrl = React.useMemo(() => {
    const params = new URLSearchParams(timeRange);
    return `/api/dashboards/${dashboardId}/stream?${params.toString()}`;
  }, [dashboardId, timeRange]);

  const applyEvent = React.useCallback(
    (event: PollerEvent) => {
      setStates((prev) => {
        if (event.type === "tick") return prev;
        const cur = prev[event.panelId];
        if (event.type === "panel-error") {
          return {
            ...prev,
            [event.panelId]: {
              data: cur?.data ?? { columns: [], rows: [] },
              status: "error",
              error: event.error,
            },
          };
        }
        if (event.type === "tombstone") {
          return {
            ...prev,
            [event.panelId]: {
              data: cur?.data ?? { columns: [], rows: [] },
              status: "tombstoned",
            },
          };
        }
        // event.type === "panel"
        const next = mergeData(cur?.data, event, maxWindowPoints);
        return {
          ...prev,
          [event.panelId]: { data: next, status: "live" },
        };
      });
    },
    [maxWindowPoints],
  );

  React.useEffect(() => {
    if (!live) return;
    lastTickRef.current = Date.now();
    const es = new EventSource(streamUrl);
    es.onopen = () => setStates({});
    es.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as PollerEvent;
        if (event.type === "tick") {
          lastTickRef.current = event.at;
        }
        applyEvent(event);
      } catch {
        /* ignore malformed frame */
      }
    };
    es.onerror = () => {
      // Mark everything stale on transport error; EventSource auto-reconnects.
      setStates((prev) => {
        const out: Record<string, PanelState> = {};
        for (const [k, v] of Object.entries(prev)) {
          out[k] = v.status === "live" ? { ...v, status: "stale" } : v;
        }
        return out;
      });
    };
    return () => es.close();
  }, [applyEvent, live, streamUrl]);

  // Staleness watchdog. Disabled while paused — a paused dashboard is not stale.
  React.useEffect(() => {
    if (!live) return;
    const budget = Math.max(spec.refreshIntervalMs * 2, 6_000);
    const id = setInterval(() => {
      if (Date.now() - lastTickRef.current > budget) {
        setStates((prev) => {
          const out: Record<string, PanelState> = {};
          for (const [k, v] of Object.entries(prev)) {
            out[k] = v.status === "live" ? { ...v, status: "stale" } : v;
          }
          return out;
        });
      }
    }, budget);
    return () => clearInterval(id);
  }, [spec.refreshIntervalMs, live]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        {header}
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <TimeRangeFilter value={timeRange} onChange={setTimeRange} />
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={!live}
            aria-label={live ? "Pause live updates" : "Resume live updates"}
            className="text-muted hover:text-foreground"
            onClick={() => setLive((v) => !v)}
          >
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                live ? "animate-pulse bg-success" : "bg-muted",
              )}
            />
            {live ? "Live" : "Paused"}
            {live ? (
              <Pause className="h-4 w-4" />
            ) : (
              <Play className="h-4 w-4" />
            )}
          </Button>
          {actions}
        </div>
      </div>

      <DashboardGrid
        panels={spec.panels}
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
