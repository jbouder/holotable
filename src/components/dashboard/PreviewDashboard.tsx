"use client";

import { type Dashboard, hasQuery, panelTimeRange } from "@/lib/ir";
import { DashboardGrid } from "@/components/dashboard/DashboardGrid";
import { PanelView } from "@/components/dashboard/PanelView";
import { usePreviewStates } from "@/components/dashboard/use-preview-states";
import { usePreviewValues } from "@/components/editor/variables-editor";

/**
 * One-shot preview: runs each panel's guarded query once via /api/query and
 * renders the result. Used on the create page before saving (no live poller
 * involved); the editor draws the same states on its canvas.
 */
export function PreviewDashboard({ spec }: { spec: Dashboard }) {
  // Each variable at its default or first value (#67).
  const variables = usePreviewValues(spec.variables);
  const { states, retry } = usePreviewStates(spec, variables);

  return (
    <DashboardGrid
      panels={spec.panels}
      renderPanel={(panel) => (
        <PanelView
          panel={panel}
          state={states[panel.id]}
          onRetry={hasQuery(panel) ? () => retry(panel) : undefined}
          timeRange={panelTimeRange(panel, spec.timeRange)}
        />
      )}
    />
  );
}
