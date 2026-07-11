import type { Panel } from "@/lib/ir";

/**
 * Panel grid layout helpers.
 *
 * The IR positions panels on a fixed 12-column grid ({x,y,w,h}). LLMs are
 * unreliable at grid math (overlaps, uneven widths), so new dashboards are
 * normalized through {@link autoLayoutPanels} to a predictable arrangement.
 * The server still owns time/query execution; this is presentation-only.
 */

export const GRID_COLUMNS = 12;

/** Default arrangement: two panels side by side. */
export const DEFAULT_COLUMNS = 2;

/** Column-count presets offered in the editor (all divide 12 evenly). */
export const COLUMN_PRESETS = [1, 2, 3, 4, 6] as const;

/**
 * Flow panels into `columns` equal-width columns, preserving their order and
 * each panel's height. Width is `12 / columns` (floored, min 1); each row's `y`
 * is the running max height of prior rows so panels of differing heights never
 * overlap. Pure: returns new panels and never mutates the input.
 */
export function autoLayoutPanels(
  panels: Panel[],
  columns: number = DEFAULT_COLUMNS,
): Panel[] {
  const cols = Math.min(GRID_COLUMNS, Math.max(1, Math.floor(columns)));
  const w = Math.max(1, Math.floor(GRID_COLUMNS / cols));
  let rowY = 0;
  let rowMaxH = 0;
  return panels.map((p, i) => {
    const col = i % cols;
    if (i > 0 && col === 0) {
      rowY += rowMaxH;
      rowMaxH = 0;
    }
    const h = p.layout.h;
    rowMaxH = Math.max(rowMaxH, h);
    return { ...p, layout: { ...p.layout, x: col * w, y: rowY, w, h } };
  });
}
