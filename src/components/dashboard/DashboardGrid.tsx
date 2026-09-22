"use client";

import type * as React from "react";
import type { Panel } from "@/lib/ir";
import {
  PanelErrorBoundary,
  type PanelErrorReport,
} from "@/components/dashboard/PanelErrorBoundary";

/**
 * 12-column dashboard grid. Panels are positioned from their IR layout
 * ({x,y,w,h}); row height is fixed so h maps to vertical span.
 *
 * Every panel is wrapped in a {@link PanelErrorBoundary} here rather than at
 * each call site, so the live viewer, the preview and any future surface get
 * the same isolation without having to remember to ask for it.
 */
export function DashboardGrid({
  panels,
  renderPanel,
  rowHeight = 84,
  onPanelError,
  empty,
}: {
  panels: Panel[];
  renderPanel: (panel: Panel) => React.ReactNode;
  rowHeight?: number;
  onPanelError?: (report: PanelErrorReport) => void;
  /**
   * What to draw instead of the grid when there are no panels. Passed in
   * rather than written here, because the right next action differs by surface
   * — an editor is offered the editor, a preview is simply still empty.
   */
  empty?: React.ReactNode;
}) {
  if (panels.length === 0) return empty ?? null;

  return (
    <div
      className="grid gap-4"
      style={{
        gridTemplateColumns: "repeat(12, minmax(0, 1fr))",
        gridAutoRows: `${rowHeight}px`,
      }}
    >
      {panels.map((p) => (
        <div
          key={p.id}
          style={{
            gridColumn: `${p.layout.x + 1} / span ${Math.min(p.layout.w, 12)}`,
            gridRow: `${p.layout.y + 1} / span ${p.layout.h}`,
          }}
          className="min-h-0"
        >
          <PanelErrorBoundary panel={p} onError={onPanelError}>
            {renderPanel(p)}
          </PanelErrorBoundary>
        </div>
      ))}
    </div>
  );
}
