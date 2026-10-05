"use client";

import * as React from "react";
import { type Dashboard, hasQuery, panelTimeRange, type QueryPanel } from "@/lib/ir";
import { DashboardGrid } from "@/components/dashboard/DashboardGrid";
import { PanelView, type PanelState } from "@/components/dashboard/PanelView";
import { EMPTY_ROWS, runPanelQuery } from "@/lib/panel-query";
import { usePreviewValues } from "@/components/editor/variables-editor";

/**
 * One-shot preview: runs each panel's guarded query once via /api/query and
 * renders the result. Used on the create/edit pages before saving (no live
 * poller involved).
 */
export function PreviewDashboard({ spec }: { spec: Dashboard }) {
  const [states, setStates] = React.useState<Record<string, PanelState>>({});
  // Each variable at its default or first value (#67).
  const { values: variables, ready } = usePreviewValues(spec.variables);

  const runPanel = React.useCallback(
    async (panel: QueryPanel, timeRange: Dashboard["timeRange"]) => {
      setStates((s) => ({ ...s, [panel.id]: { data: EMPTY_ROWS, status: "loading" } }));
      // A panel with its own window (#114) is previewed over it.
      const outcome = await runPanelQuery(panel.query, panelTimeRange(panel, timeRange), {
        variables,
      });
      setStates((s) => ({
        ...s,
        [panel.id]: outcome.ok
          ? { data: outcome.rows, status: "live", updatedAt: Date.now() }
          : { data: EMPTY_ROWS, status: "error", error: outcome.error },
      }));
    },
    [variables],
  );

  // `spec` is a fresh object on every render, so depending on it directly would
  // re-run the preview on every render. The serialized spec is the real
  // dependency: it changes exactly when the generated content changes.
  // `runPanel` is a useCallback with no dependencies and is stable.
  const specKey = JSON.stringify(spec);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the serialized spec on purpose
  React.useEffect(() => {
    // Not before the variables' values are known: a panel that references one
    // would only be refused for lacking it.
    if (!ready) return;
    // A text panel (#202) has nothing to run; it renders as it is.
    for (const panel of spec.panels.filter(hasQuery))
      void runPanel(panel, spec.timeRange);
  }, [specKey, runPanel, ready]);

  return (
    <DashboardGrid
      panels={spec.panels}
      renderPanel={(panel) => (
        <PanelView
          panel={panel}
          state={states[panel.id]}
          onRetry={
            hasQuery(panel) ? () => void runPanel(panel, spec.timeRange) : undefined
          }
          timeRange={panelTimeRange(panel, spec.timeRange)}
        />
      )}
    />
  );
}
