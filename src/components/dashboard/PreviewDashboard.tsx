"use client";

import * as React from "react";
import type { Dashboard, Panel } from "@/lib/ir";
import { DashboardGrid } from "@/components/dashboard/DashboardGrid";
import { PanelView, type PanelState } from "@/components/dashboard/PanelView";

/**
 * One-shot preview: runs each panel's guarded query once via /api/query and
 * renders the result. Used on the create/edit pages before saving (no live
 * poller involved).
 */
export function PreviewDashboard({ spec }: { spec: Dashboard }) {
  const [states, setStates] = React.useState<Record<string, PanelState>>({});

  const runPanel = React.useCallback(
    async (panel: Panel, timeRange: Dashboard["timeRange"]) => {
      setStates((s) => ({
        ...s,
        [panel.id]: { data: { columns: [], rows: [] }, status: "loading" },
      }));
      try {
        const res = await fetch("/api/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sourceId: panel.query.sourceId,
            sql: panel.query.sql,
            timeField: panel.query.timeField,
            timeRange,
          }),
        });
        const body = await res.json();
        if (!res.ok) {
          setStates((s) => ({
            ...s,
            [panel.id]: {
              data: { columns: [], rows: [] },
              status: "error",
              error: body.error ?? "query failed",
            },
          }));
          return;
        }
        setStates((s) => ({
          ...s,
          [panel.id]: {
            data: { columns: body.columns, rows: body.rows },
            status: "live",
          },
        }));
      } catch (err) {
        setStates((s) => ({
          ...s,
          [panel.id]: {
            data: { columns: [], rows: [] },
            status: "error",
            error: err instanceof Error ? err.message : "query failed",
          },
        }));
      }
    },
    [],
  );

  React.useEffect(() => {
    for (const panel of spec.panels) void runPanel(panel, spec.timeRange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(spec)]);

  return (
    <DashboardGrid
      panels={spec.panels}
      renderPanel={(panel) => <PanelView panel={panel} state={states[panel.id]} />}
    />
  );
}
