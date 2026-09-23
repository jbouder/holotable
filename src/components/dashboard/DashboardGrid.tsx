"use client";

import type * as React from "react";
import type { Panel } from "@/lib/ir";
import { GRID_COLUMNS } from "@/lib/layout";
import {
  PanelErrorBoundary,
  type PanelErrorReport,
} from "@/components/dashboard/PanelErrorBoundary";
import {
  BREAKPOINT_COLUMNS,
  gridArea,
  reflowLayouts,
  rowHeightAt,
} from "@/lib/responsive-grid";
import { cn } from "@/lib/utils";

/**
 * The dashboard grid. Panels are positioned from their IR layout ({x,y,w,h})
 * on the 12-column grid the spec is written against, and re-flowed into six
 * columns on a tablet and one on a phone (#78).
 *
 * The three arrangements are emitted together, as custom properties the
 * Tailwind variants below read at each media query — the IR's coordinates are
 * never touched, nothing measures the viewport, and a reader who opens a
 * dashboard on a phone and saves it saves the same 12-column spec.
 *
 * Every panel is wrapped in a {@link PanelErrorBoundary} here rather than at
 * each call site, so the live viewer, the preview and any future surface get
 * the same isolation without having to remember to ask for it.
 */
export function DashboardGrid({
  panels,
  renderPanel,
  rowHeight = 84,
  responsive = true,
  onPanelError,
  empty,
}: {
  panels: Panel[];
  renderPanel: (panel: Panel) => React.ReactNode;
  rowHeight?: number;
  /**
   * Whether to collapse to fewer columns on a narrow viewport. The editor's
   * arranger turns this off: it is the surface where 12-column coordinates are
   * *authored*, and a drag measured against six columns would commit a
   * position the author did not choose. It scrolls sideways instead.
   */
  responsive?: boolean;
  onPanelError?: (report: PanelErrorReport) => void;
  /**
   * What to draw instead of the grid when there are no panels. Passed in
   * rather than written here, because the right next action differs by surface
   * — an editor is offered the editor, a preview is simply still empty.
   */
  empty?: React.ReactNode;
}) {
  if (panels.length === 0) return empty ?? null;

  // A non-responsive surface renders the authored grid at every width; the
  // three custom properties still exist so the class list stays one shape.
  const columns = responsive
    ? BREAKPOINT_COLUMNS
    : { sm: GRID_COLUMNS, md: GRID_COLUMNS, lg: GRID_COLUMNS };
  const layouts = {
    sm: reflowLayouts(panels, columns.sm),
    md: reflowLayouts(panels, columns.md),
    lg: reflowLayouts(panels, columns.lg),
  };
  const rows = responsive
    ? {
        sm: rowHeightAt("sm", rowHeight),
        md: rowHeightAt("md", rowHeight),
        lg: rowHeightAt("lg", rowHeight),
      }
    : { sm: rowHeight, md: rowHeight, lg: rowHeight };

  return (
    <div
      className={cn(
        "grid gap-4",
        "[grid-auto-rows:var(--row-sm)] md:[grid-auto-rows:var(--row-md)] lg:[grid-auto-rows:var(--row-lg)]",
        responsive ? "grid-cols-1 md:grid-cols-6 lg:grid-cols-12" : "grid-cols-12",
      )}
      style={
        {
          "--row-sm": `${rows.sm}px`,
          "--row-md": `${rows.md}px`,
          "--row-lg": `${rows.lg}px`,
        } as React.CSSProperties
      }
    >
      {panels.map((panel, i) => (
        <div
          key={panel.id}
          style={
            {
              "--area-sm": gridArea(layouts.sm[i], columns.sm),
              "--area-md": gridArea(layouts.md[i], columns.md),
              "--area-lg": gridArea(layouts.lg[i], columns.lg),
            } as React.CSSProperties
          }
          className="min-h-0 [grid-area:var(--area-sm)] md:[grid-area:var(--area-md)] lg:[grid-area:var(--area-lg)]"
        >
          <PanelErrorBoundary panel={panel} onError={onPanelError}>
            {renderPanel(panel)}
          </PanelErrorBoundary>
        </div>
      ))}
    </div>
  );
}
