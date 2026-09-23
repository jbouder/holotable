import type { Panel, PanelLayout } from "@/lib/ir";
import { GRID_COLUMNS } from "@/lib/layout";

/**
 * Breakpoint mapping for the dashboard grid.
 *
 * The IR positions panels on a fixed 12-column grid, and that is the only
 * arrangement anything persists. A 3-wide panel is a quarter of a phone
 * screen, though, so the *renderer* flows the same panels into fewer columns
 * below the desktop breakpoint. Presentation-only, by construction: these
 * functions take layouts and return layouts, nothing here is written back to
 * a spec, and `DashboardGrid` emits all three arrangements as CSS so the
 * browser — not a resize listener — picks one.
 */

export type Breakpoint = "sm" | "md" | "lg";

/** Every breakpoint the grid renders, narrowest first. */
export const BREAKPOINTS = ["sm", "md", "lg"] as const;

/**
 * Columns per breakpoint. `lg` is the IR's own grid, so a desktop reader sees
 * exactly what the author arranged; the narrower two are re-flowed.
 *
 * These must stay in step with the Tailwind variants in `DashboardGrid`:
 * unprefixed is `sm` here, `md:` is `md`, `lg:` is `lg`.
 */
export const BREAKPOINT_COLUMNS: Record<Breakpoint, number> = {
  sm: 1,
  md: 6,
  lg: GRID_COLUMNS,
};

/**
 * Row height per breakpoint, as a fraction of the surface's own. A panel keeps
 * its `h`, so scaling the row is what keeps a 4-row chart from eating a phone
 * screen while staying tall enough to read.
 */
const ROW_HEIGHT_SCALE: Record<Breakpoint, number> = {
  sm: 0.72,
  md: 0.86,
  lg: 1,
};

export function rowHeightAt(breakpoint: Breakpoint, rowHeight: number): number {
  return Math.max(1, Math.round(rowHeight * ROW_HEIGHT_SCALE[breakpoint]));
}

/**
 * Re-flow panels into `columns`, preserving reading order and relative width.
 *
 * Panels are taken in `y` then `x` order — the order someone reads them in on
 * a wide screen — each given a proportional width, and laid out left to right,
 * wrapping when the row is full. Returned in the *input* order so the caller
 * can zip them back onto its own array.
 *
 * Re-flowing rather than rescaling the coordinates is what makes overlaps
 * impossible: two panels the arithmetic would have rounded onto the same cell
 * simply become two cells in sequence. At `GRID_COLUMNS` the authored layout
 * is returned untouched, so nothing a reader drags into place is reinterpreted
 * on the screen it was arranged on.
 */
export function reflowLayouts(panels: Panel[], columns: number): PanelLayout[] {
  const cols = Math.min(GRID_COLUMNS, Math.max(1, Math.floor(columns)));
  if (cols === GRID_COLUMNS) return panels.map((p) => p.layout);

  const reading = panels
    .map((panel, index) => ({ panel, index }))
    .sort(
      (a, b) =>
        a.panel.layout.y - b.panel.layout.y ||
        a.panel.layout.x - b.panel.layout.x ||
        a.index - b.index,
    );

  const out: PanelLayout[] = new Array(panels.length);
  let x = 0;
  let y = 0;
  let rowHeight = 0;

  for (const { panel, index } of reading) {
    const w = Math.min(
      cols,
      Math.max(1, Math.round((panel.layout.w * cols) / GRID_COLUMNS)),
    );
    if (x > 0 && x + w > cols) {
      y += rowHeight;
      x = 0;
      rowHeight = 0;
    }
    out[index] = { x, y, w, h: panel.layout.h };
    x += w;
    rowHeight = Math.max(rowHeight, panel.layout.h);
  }

  return out;
}

/**
 * A layout as a CSS `grid-area` shorthand: `row / column / span h / span w`.
 *
 * Emitted per breakpoint into a custom property, which the grid's Tailwind
 * classes read at each media query. That is what keeps the mapping free of
 * JavaScript: there is no measured width, no resize handler and no first paint
 * at the wrong size, because all three arrangements ship in the markup and the
 * browser applies whichever one matches.
 */
export function gridArea(layout: PanelLayout, columns: number): string {
  const w = Math.min(Math.max(1, layout.w), columns);
  return `${layout.y + 1} / ${layout.x + 1} / span ${Math.max(1, layout.h)} / span ${w}`;
}
