"use client";

import * as React from "react";
import type { Panel } from "@/lib/ir";

/**
 * 12-column dashboard grid. Panels are positioned from their IR layout
 * ({x,y,w,h}); row height is fixed so h maps to vertical span.
 */
export function DashboardGrid({
  panels,
  renderPanel,
  rowHeight = 84,
}: {
  panels: Panel[];
  renderPanel: (panel: Panel) => React.ReactNode;
  rowHeight?: number;
}) {
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
          {renderPanel(p)}
        </div>
      ))}
    </div>
  );
}
