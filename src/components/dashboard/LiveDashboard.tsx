"use client";

import * as React from "react";
import type { Dashboard } from "@/lib/ir";
import type { PollerEvent } from "@/lib/poller/registry";
import { DashboardGrid } from "@/components/dashboard/DashboardGrid";
import { PanelView, type PanelState } from "@/components/dashboard/PanelView";
import type { PanelData } from "@/components/charts/options";

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
}: {
  dashboardId: string;
  spec: Dashboard;
  maxWindowPoints: number;
}) {
  const [states, setStates] = React.useState<Record<string, PanelState>>({});
  const lastTickRef = React.useRef<number>(0);

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
    lastTickRef.current = Date.now();
    const es = new EventSource(`/api/dashboards/${dashboardId}/stream`);
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
  }, [dashboardId, applyEvent]);

  // Staleness watchdog.
  React.useEffect(() => {
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
  }, [spec.refreshIntervalMs]);

  return (
    <DashboardGrid
      panels={spec.panels}
      renderPanel={(panel) => (
        <PanelView panel={panel} state={states[panel.id]} />
      )}
    />
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
