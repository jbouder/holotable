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
import { isPanelDeleteKey } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

/**
 * Direct manipulation of the panel grid.
 *
 * Rendered through {@link DashboardGrid} on purpose: the arranger and the
 * viewer share one renderer, so what an author drags into place is what the
 * dashboard shows. By default the tiles are placeholders; the editor's canvas
 * (#357) passes `renderBody` to draw each panel itself under the handle. The
 * body is keyed by panel id like any other grid cell, so a drag moves the
 * chart's card and never recreates the chart, and it is `inert`: the handle
 * on top is the one control a pointer or a Tab reaches.
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
  onDelete,
  renderBody,
  rowHeight = ARRANGE_ROW_HEIGHT,
  empty,
}: {
  panels: Panel[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onChange: (panels: Panel[]) => void;
  /** Delete or Backspace on a focused tile (#77). Absent, the keys do nothing. */
  onDelete?: (id: string) => void;
  /** What to draw under each tile's handle; absent, the tile names the panel. */
  renderBody?: (panel: Panel) => React.ReactNode;
  /** Grid row height in pixels; the drag math measures cells with the same value. */
  rowHeight?: number;
  /** Replaces the default "No panels yet" line. */
  empty?: React.ReactNode;
}) {
  const container = React.useRef<HTMLDivElement>(null);
  const [drag, setDrag] = React.useState<Drag | null>(null);
  const [preview, setPreview] = React.useState<Panel[] | null>(null);
  // While a gesture is in flight the grid shows where it would land; the spec
  // itself is untouched until the pointer comes up.
  const shown = preview ?? panels;

  function begin(e: React.PointerEvent<HTMLButtonElement>, panel: Panel, mode: DragMode) {
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
      step: cellStep(width, rowHeight),
    });
  }

  function track(e: React.PointerEvent<HTMLButtonElement>) {
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

  function end(e: React.PointerEvent<HTMLButtonElement>, commit: boolean) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (commit && preview && !sameLayouts(preview, panels)) onChange(preview);
    setDrag(null);
    setPreview(null);
  }

  /**
   * Arrow keys move the panel; with Shift (or from the handle) they resize it.
   * Delete removes it, through the editor's own delete, which asks first when
   * there is work to lose and is one step to undo.
   */
  function nudge(
    e: React.KeyboardEvent<HTMLButtonElement>,
    panel: Panel,
    mode: DragMode,
  ) {
    if (isPanelDeleteKey(e.key) && mode === "move" && onDelete) {
      e.preventDefault();
      onDelete(panel.id);
      return;
    }
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
    if (empty) return empty;
    return (
      <p className="py-6 text-center text-sm text-muted">
        No panels yet. Add one to arrange it here.
      </p>
    );
  }

  return (
    // The arranger authors 12-column coordinates, so it keeps all twelve at
    // every width and scrolls sideways when they do not fit: a drag measured
    // against a re-flowed six-column grid would commit a position the author
    // never chose (#78). `container` is the inner element on purpose — the
    // pixel-to-cell math needs the grid's width, not the viewport's.
    <div className="overflow-x-auto pb-1">
      <div ref={container} className="min-w-[34rem]">
        <DashboardGrid
          panels={shown}
          responsive={false}
          rowHeight={rowHeight}
          // The displaced tiles slide as the dragged one pushes them; the
          // dragged tile itself snaps with the pointer (#237).
          pinnedId={drag?.id ?? null}
          renderPanel={(panel) => {
            const { x, y, w, h } = panel.layout;
            const active = drag?.id === panel.id;
            const selected = panel.id === selectedId;
            return (
              <div className="relative h-full">
                {renderBody && (
                  <div inert className="pointer-events-none h-full">
                    {renderBody(panel)}
                  </div>
                )}
                <button
                  type="button"
                  aria-label={`${panel.title}, column ${x + 1}, row ${y + 1}, ${w} of 12 wide, ${h} rows tall. Arrow keys move, shift and arrow keys resize${onDelete ? ", Delete removes" : ""}.`}
                  onPointerDown={(e) => begin(e, panel, "move")}
                  onPointerMove={track}
                  onPointerUp={(e) => end(e, true)}
                  onPointerCancel={(e) => end(e, false)}
                  onKeyDown={(e) => nudge(e, panel, "move")}
                  onClick={() => onSelect?.(panel.id)}
                  aria-pressed={renderBody ? selected : undefined}
                  className={cn(
                    "absolute inset-0 flex touch-none select-none flex-col items-start gap-0.5 overflow-hidden text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                    active ? "cursor-grabbing" : "cursor-grab",
                    renderBody
                      ? // Over a live panel the handle is only an outline.
                        selected
                        ? "ring-2 ring-primary ring-inset"
                        : "hover:ring-1 hover:ring-primary/60 hover:ring-inset"
                      : cn(
                          "border p-2",
                          selected
                            ? "border-primary bg-surface-2"
                            : "border-border bg-surface hover:bg-surface-2",
                        ),
                  )}
                >
                  {!renderBody && (
                    <>
                      <span className="w-full truncate text-xs font-medium">
                        {panel.title}
                      </span>
                      <span className="text-[10px] text-muted">
                        {panel.viz} · {w}×{h}
                      </span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  aria-label={`Resize ${panel.title}. Arrow keys resize.`}
                  onPointerDown={(e) => begin(e, panel, "resize")}
                  onPointerMove={track}
                  onPointerUp={(e) => end(e, true)}
                  onPointerCancel={(e) => end(e, false)}
                  onKeyDown={(e) => nudge(e, panel, "resize")}
                  className="absolute bottom-0 right-0 z-10 h-4 w-4 cursor-se-resize touch-none border-b-2 border-r-2 border-muted hover:border-primary"
                />
              </div>
            );
          }}
        />
      </div>
    </div>
  );
}
