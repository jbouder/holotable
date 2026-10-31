"use client";

import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronsDownUp,
  ChevronsLeftRight,
  ChevronsRightLeft,
  ChevronsUpDown,
} from "lucide-react";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import type { PanelLayout } from "@/lib/ir";

type Step = {
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  next: (l: PanelLayout) => PanelLayout;
};

const MOVE: Step[] = [
  { label: "Move left", Icon: ArrowLeft, next: (l) => ({ ...l, x: l.x - 1 }) },
  { label: "Move up", Icon: ArrowUp, next: (l) => ({ ...l, y: l.y - 1 }) },
  { label: "Move down", Icon: ArrowDown, next: (l) => ({ ...l, y: l.y + 1 }) },
  { label: "Move right", Icon: ArrowRight, next: (l) => ({ ...l, x: l.x + 1 }) },
];

const SIZE: Step[] = [
  { label: "Narrower", Icon: ChevronsRightLeft, next: (l) => ({ ...l, w: l.w - 1 }) },
  { label: "Wider", Icon: ChevronsLeftRight, next: (l) => ({ ...l, w: l.w + 1 }) },
  { label: "Shorter", Icon: ChevronsDownUp, next: (l) => ({ ...l, h: l.h - 1 }) },
  { label: "Taller", Icon: ChevronsUpDown, next: (l) => ({ ...l, h: l.h + 1 }) },
];

/**
 * Move and resize the selected panel a grid cell at a time, with clicks alone
 * (#681, WCAG 2.5.7): what a drag on the canvas does, and what the arrow keys
 * (Shift for size) do on a focused tile. Each step goes through the editor's
 * one layout path, so the other panels make room the same way and it undoes
 * the same.
 *
 * No button disables at the grid's edge: a step there clamps to nothing, and
 * a button that disabled itself under focus would drop it to the page (#540).
 * The line above them says where the panel is now, and is announced.
 */
export function PanelLayoutControls({
  layout,
  onLayout,
}: {
  layout: PanelLayout;
  onLayout: (next: PanelLayout) => void;
}) {
  const row = (steps: Step[]) =>
    steps.map(({ label, Icon, next }) => (
      <Button
        key={label}
        variant="secondary"
        size="icon"
        aria-label={label}
        title={label}
        onClick={() => onLayout(next(layout))}
      >
        <Icon className="h-4 w-4" />
      </Button>
    ));
  return (
    <div className="space-y-3">
      <p role="status" className="text-sm text-muted">
        Column {layout.x + 1}, row {layout.y + 1}; {layout.w}{" "}
        {layout.w === 1 ? "column" : "columns"} wide, {layout.h}{" "}
        {layout.h === 1 ? "row" : "rows"} tall.
      </p>
      <div className="flex flex-wrap gap-x-6 gap-y-3">
        <fieldset className="space-y-1">
          <legend className="text-xs text-muted">Move</legend>
          <div className="flex gap-1">{row(MOVE)}</div>
        </fieldset>
        <fieldset className="space-y-1">
          <legend className="text-xs text-muted">Size</legend>
          <div className="flex gap-1">{row(SIZE)}</div>
        </fieldset>
      </div>
    </div>
  );
}
