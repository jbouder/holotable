import type { Panel, PanelLayout } from "@/lib/ir";
import { GRID_COLUMNS } from "@/lib/layout";

/**
 * Direct-manipulation grid math for the editor's layout arranger.
 *
 * `autoLayoutPanels` in `src/lib/layout.ts` flows panels into even columns;
 * this is the other half: what a single dragged or nudged panel does to the
 * arrangement around it. Every result is clamped to the IR's `PanelLayout`
 * bounds and left free of overlaps, so the arranger can only ever produce a
 * layout the viewer renders the same way. Pure: nothing here touches the DOM.
 */

/** `PanelLayout.y` bound in the IR. */
export const MAX_ROW = 1000;
/** `PanelLayout.h` bound in the IR. */
export const MAX_HEIGHT = 48;

/**
 * Row height the arranger renders with. Smaller than the viewer's 84px so a
 * tall dashboard is arrangeable without scrolling; proportions are unchanged
 * because every row uses it.
 */
export const ARRANGE_ROW_HEIGHT = 44;

/** The `gap-4` between grid cells, in pixels. Needed for pixel→cell math. */
export const GRID_GAP = 16;

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Force a layout into the IR bounds. `x` is additionally capped so `x + w`
 * stays on the 12-column grid — `DashboardGrid` spans from `x`, so a wider
 * value would render clipped rather than wrapped.
 */
export function clampLayout(layout: PanelLayout): PanelLayout {
  const w = clampInt(layout.w, 1, GRID_COLUMNS);
  const h = clampInt(layout.h, 1, MAX_HEIGHT);
  return {
    x: clampInt(layout.x, 0, GRID_COLUMNS - w),
    y: clampInt(layout.y, 0, MAX_ROW),
    w,
    h,
  };
}

/** Do two grid rectangles share any cell? */
export function overlaps(a: PanelLayout, b: PanelLayout): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Push every panel that collides with the anchor (and then with each other)
 * downward until nothing overlaps. The anchor keeps exactly the position it
 * was dropped at; the rest are processed top-to-bottom so the result depends
 * only on the arrangement, not on array order.
 *
 * Panels are never pulled back up: a dashboard that drifts downward after a
 * lot of manual dragging is re-tidied with the `Arrange: N-up` presets.
 */
export function resolveOverlaps(panels: Panel[], anchorId: string): Panel[] {
  const anchor = panels.find((p) => p.id === anchorId);
  const placed: PanelLayout[] = anchor ? [anchor.layout] : [];
  const moved = new Map<string, PanelLayout>();

  const rest = panels
    .filter((p) => p.id !== anchorId)
    .sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x);

  for (const panel of rest) {
    let y = panel.layout.y;
    let shifted = true;
    while (shifted) {
      shifted = false;
      for (const other of placed) {
        if (overlaps({ ...panel.layout, y }, other)) {
          y = other.y + other.h;
          shifted = true;
        }
      }
    }
    const layout =
      y === panel.layout.y ? panel.layout : clampLayout({ ...panel.layout, y });
    placed.push(layout);
    if (layout !== panel.layout) moved.set(panel.id, layout);
  }

  if (moved.size === 0) return panels;
  return panels.map((p) => {
    const layout = moved.get(p.id);
    return layout ? { ...p, layout } : p;
  });
}

/**
 * Give one panel a new layout and settle the rest around it. This is the one
 * entry point the arranger commits through, so a drag, a resize and a keyboard
 * nudge all produce the same guarantees — and one undo entry each.
 */
export function applyLayout(panels: Panel[], id: string, next: PanelLayout): Panel[] {
  const layout = clampLayout(next);
  const updated = panels.map((p) => (p.id === id ? { ...p, layout } : p));
  return resolveOverlaps(updated, id);
}

/** Pixel size of one grid cell plus its trailing gap, on both axes. */
export interface CellStep {
  x: number;
  y: number;
}

export function cellStep(
  containerWidth: number,
  rowHeight: number = ARRANGE_ROW_HEIGHT,
  gap: number = GRID_GAP,
): CellStep {
  const column = (containerWidth - gap * (GRID_COLUMNS - 1)) / GRID_COLUMNS;
  return { x: Math.max(1, column + gap), y: Math.max(1, rowHeight + gap) };
}

/** Pointer travel in pixels → whole grid cells, snapped to the nearest. */
export function snapDelta(
  dx: number,
  dy: number,
  step: CellStep,
): { dx: number; dy: number } {
  return { dx: Math.round(dx / step.x), dy: Math.round(dy / step.y) };
}

/** Same panels in the same order with the same positions? */
export function sameLayouts(a: Panel[], b: Panel[]): boolean {
  return (
    a.length === b.length &&
    a.every((p, i) => {
      const q = b[i];
      return (
        p.id === q.id &&
        p.layout.x === q.layout.x &&
        p.layout.y === q.layout.y &&
        p.layout.w === q.layout.w &&
        p.layout.h === q.layout.h
      );
    })
  );
}
