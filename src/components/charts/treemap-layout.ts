/**
 * Where ECharts will draw a treemap's nodes, worked out before it does
 * (#657), so a label that would not fit its cell is left out whole rather
 * than cut to `host-…`. A builder is not told the cells ECharts lays out, so
 * this repeats its squarified layout (`treemapLayout.js` in ECharts, after
 * d3's): the same order, the same golden-ratio rows, the same borders,
 * gaps and header bands. It is pure, and runs on the panel's measured size
 * (`ChartContext.size`), which is stepped down, so a cell here is never
 * larger than the one drawn and a label judged to fit does.
 */

/** A node as the layout needs it: its id, its value, and its children, largest first. */
export interface LayoutNode {
  id: string;
  value: number;
  children: readonly LayoutNode[];
}

/** How the series draws its nodes: what parts them and how tall a header is. */
export interface LayoutGeometry {
  /** The gap between top-level nodes (ECharts' root level's `gapWidth`). */
  rootGap: number;
  /** A parent's inset on its sides and bottom (`borderWidth`). */
  border: number;
  /** The gap between a parent's children (`gapWidth`). */
  gap: number;
  /** A parent's header band (`upperLabel.height`). */
  header: number;
}

/** A node's drawn size. */
export interface Cell {
  width: number;
  height: number;
}

/** ECharts' default `squareRatio`. */
const SQUARE_RATIO = 0.5 * (1 + Math.sqrt(5));

interface Placed {
  node: LayoutNode;
  area: number;
  width: number;
  height: number;
}

/** Every node's cell in a box of `width` by `height`, by id. */
export function treemapCells(
  roots: readonly LayoutNode[],
  width: number,
  height: number,
  g: LayoutGeometry,
): Map<string, Cell> {
  const out = new Map<string, Cell>();
  const lay = (
    children: readonly LayoutNode[],
    outer: Cell,
    border: number,
    upper: number,
    halfGap: number,
  ) => {
    const offset = border - halfGap;
    const offsetUpper = upper - halfGap;
    const w = Math.max(outer.width - 2 * offset, 0);
    const h = Math.max(outer.height - offset - offsetUpper, 0);
    const total = children.reduce((s, c) => s + c.value, 0);
    if (total <= 0 || w * h === 0) return [];
    // ECharts' order: largest first, and of equal values the later one.
    const placed: Placed[] = children
      .map((node, index) => ({ node, index }))
      .sort((a, b) => b.node.value - a.node.value || b.index - a.index)
      .map(({ node }) => ({
        node,
        area: (node.value / total) * w * h,
        width: 0,
        height: 0,
      }));
    const rect = { width: w, height: h };
    let fixed = Math.min(w, h);
    let best = Number.POSITIVE_INFINITY;
    let row: Placed[] = [];
    let rowArea = 0;
    for (let i = 0; i < placed.length; ) {
      const next = placed[i];
      row.push(next);
      rowArea += next.area;
      const score = worst(row, rowArea, fixed);
      if (score <= best) {
        i++;
        best = score;
      } else {
        row.pop();
        rowArea -= next.area;
        position(row, rowArea, fixed, rect, halfGap, false);
        fixed = Math.min(rect.width, rect.height);
        row = [];
        rowArea = 0;
        best = Number.POSITIVE_INFINITY;
      }
    }
    if (row.length > 0) position(row, rowArea, fixed, rect, halfGap, true);
    return placed;
  };
  const walk = (
    children: readonly LayoutNode[],
    outer: Cell,
    border: number,
    upper: number,
    halfGap: number,
  ) => {
    for (const p of lay(children, outer, border, upper, halfGap)) {
      const cell = { width: p.width, height: p.height };
      out.set(p.node.id, cell);
      if (p.node.children.length > 0) {
        walk(p.node.children, cell, g.border, Math.max(g.border, g.header), g.gap / 2);
      }
    }
  };
  walk(roots, { width, height }, 0, 0, g.rootGap / 2);
  return out;
}

/** The row's worst aspect ratio, as ECharts scores it. */
function worst(row: readonly Placed[], rowArea: number, fixed: number): number {
  let max = 0;
  let min = Number.POSITIVE_INFINITY;
  for (const p of row) {
    if (p.area) {
      if (p.area < min) min = p.area;
      if (p.area > max) max = p.area;
    }
  }
  const square = rowArea * rowArea;
  const f = fixed * fixed * SQUARE_RATIO;
  return square
    ? Math.max((f * max) / square, square / (f * min))
    : Number.POSITIVE_INFINITY;
}

/** Lays a row along the rect's shorter side, and takes it off the rect. */
function position(
  row: readonly Placed[],
  rowArea: number,
  fixed: number,
  rect: { width: number; height: number },
  halfGap: number,
  flush: boolean,
) {
  const horizontal = fixed === rect.width;
  const across = horizontal ? rect.height : rect.width;
  const along = horizontal ? rect.width : rect.height;
  let other = fixed ? rowArea / fixed : 0;
  if (flush || other > across) other = across;
  let used = 0;
  row.forEach((p, i) => {
    const step = other ? p.area / other : 0;
    const remain = along - used;
    const length = i === row.length - 1 || remain < step ? remain : step;
    const a = Math.max(length - 2 * halfGap, 0);
    const b = Math.max(other - 2 * halfGap, 0);
    p.width = horizontal ? a : b;
    p.height = horizontal ? b : a;
    used += length;
  });
  if (horizontal) rect.height -= other;
  else rect.width -= other;
}
