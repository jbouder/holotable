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

  // `spec` is a fresh object on every render, so depending on it directly would
  // re-run the preview on every render. The serialized spec is the real
  // dependency: it changes exactly when the generated content changes.
  // `runPanel` is a useCallback with no dependencies and is stable.
  const specKey = JSON.stringify(spec);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the serialized spec on purpose
  React.useEffect(() => {
    for (const panel of spec.panels) void runPanel(panel, spec.timeRange);
  }, [specKey]);

  return (
    <DashboardGrid
      panels={spec.panels}
      renderPanel={(panel) => (
        <PanelView
          panel={panel}
          state={states[panel.id]}
          onRetry={() => void runPanel(panel, spec.timeRange)}
        />
      )}
    />
  );
}
