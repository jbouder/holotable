"use client";

import * as React from "react";
import type { Panel, PanelLayout } from "@/lib/ir";
import { DashboardGrid } from "@/components/dashboard/DashboardGrid";
import {
  applyLayout,
  ARRANGE_ROW_HEIGHT,
  type CellStep,
  cellStep,
  sameLayouts,
  snapDelta,
} from "@/lib/grid-layout";
import { cn } from "@/lib/utils";

/**
 * Direct manipulation of the panel grid.
 *
 * Rendered through {@link DashboardGrid} on purpose: the arranger and the
 * viewer share one renderer, so what an author drags into place is what the
 * dashboard shows. The tiles are placeholders, not live panels — this surface
 * is about position, and running every query again on every drag frame is not
 * what it is for.
 *
 * A drag previews locally and commits once on release, so the spec sees one
 * change per gesture rather than one per pointer move (#81).
 */

type DragMode = "move" | "resize";

interface Drag {
  id: string;
  mode: DragMode;
  pointerId: number;
  /** Pointer position when the gesture started. */
  fromX: number;
  fromY: number;
  /** Layout the gesture started from; deltas apply to this, not to the last frame. */
  layout: PanelLayout;
  step: CellStep;
}

const NUDGE: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

export function PanelLayoutGrid({
  panels,
  selectedId,
  onSelect,
  onChange,
}: {
  panels: Panel[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onChange: (panels: Panel[]) => void;
}) {
  const container = React.useRef<HTMLDivElement>(null);
  const [drag, setDrag] = React.useState<Drag | null>(null);
  const [preview, setPreview] = React.useState<Panel[] | null>(null);
  // While a gesture is in flight the grid shows where it would land; the spec
  // itself is untouched until the pointer comes up.
  const shown = preview ?? panels;

  function begin(e: React.PointerEvent, panel: Panel, mode: DragMode) {
    const width = container.current?.getBoundingClientRect().width ?? 0;
    if (width <= 0 || e.button !== 0) return;
    // Suppressing the default also suppresses focus, and a panel that cannot
    // be focused cannot then be nudged with the arrow keys.
    e.preventDefault();
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture(e.pointerId);
    onSelect?.(panel.id);
    setDrag({
      id: panel.id,
      mode,
      pointerId: e.pointerId,
      fromX: e.clientX,
      fromY: e.clientY,
      layout: panel.layout,
      step: cellStep(width),
    });
  }

  function track(e: React.PointerEvent) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const { dx, dy } = snapDelta(
      e.clientX - drag.fromX,
      e.clientY - drag.fromY,
      drag.step,
    );
    const next =
      drag.mode === "move"
        ? { ...drag.layout, x: drag.layout.x + dx, y: drag.layout.y + dy }
        : { ...drag.layout, w: drag.layout.w + dx, h: drag.layout.h + dy };
    setPreview(applyLayout(panels, drag.id, next));
  }

  function end(e: React.PointerEvent, commit: boolean) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (commit && preview && !sameLayouts(preview, panels)) onChange(preview);
    setDrag(null);
    setPreview(null);
  }

  /** Arrow keys move the panel; with Shift (or from the handle) they resize it. */
  function nudge(e: React.KeyboardEvent, panel: Panel, mode: DragMode) {
    const step = NUDGE[e.key];
    if (!step) return;
    e.preventDefault();
    const [dx, dy] = step;
    const resizing = mode === "resize" || e.shiftKey;
    const next = resizing
      ? { ...panel.layout, w: panel.layout.w + dx, h: panel.layout.h + dy }
      : { ...panel.layout, x: panel.layout.x + dx, y: panel.layout.y + dy };
    const nextPanels = applyLayout(panels, panel.id, next);
    if (!sameLayouts(nextPanels, panels)) onChange(nextPanels);
  }

  if (panels.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted">
        No panels yet. Add one to arrange it here.
      </p>
    );
  }

  return (
    <div ref={container}>
      <DashboardGrid
        panels={shown}
        rowHeight={ARRANGE_ROW_HEIGHT}
        renderPanel={(panel) => {
          const { x, y, w, h } = panel.layout;
          const active = drag?.id === panel.id;
          return (
            <div className="relative h-full">
              <button
                type="button"
                aria-label={`${panel.title}, column ${x + 1}, row ${y + 1}, ${w} of 12 wide, ${h} rows tall. Arrow keys move, shift and arrow keys resize.`}
                onPointerDown={(e) => begin(e, panel, "move")}
                onPointerMove={track}
                onPointerUp={(e) => end(e, true)}
                onPointerCancel={(e) => end(e, false)}
                onKeyDown={(e) => nudge(e, panel, "move")}
                onClick={() => onSelect?.(panel.id)}
                className={cn(
                  "absolute inset-0 flex touch-none select-none flex-col items-start gap-0.5 overflow-hidden rounded-lg border p-2 text-left transition-colors",
                  active ? "cursor-grabbing" : "cursor-grab",
                  panel.id === selectedId
                    ? "border-primary bg-surface-2"
                    : "border-border bg-surface hover:bg-surface-2",
                )}
              >
                <span className="w-full truncate text-xs font-medium">{panel.title}</span>
                <span className="text-[10px] text-muted">
                  {panel.viz} · {w}×{h}
                </span>
              </button>
              <button
                type="button"
                aria-label={`Resize ${panel.title}. Arrow keys resize.`}
                onPointerDown={(e) => begin(e, panel, "resize")}
                onPointerMove={track}
                onPointerUp={(e) => end(e, true)}
                onPointerCancel={(e) => end(e, false)}
                onKeyDown={(e) => nudge(e, panel, "resize")}
                className="absolute bottom-0 right-0 h-4 w-4 cursor-se-resize touch-none rounded-br-lg border-b-2 border-r-2 border-muted hover:border-primary"
              />
            </div>
          );
        }}
      />
    </div>
  );
}
