import { blockLine, nodeBlock } from "@/components/charts/style";
import { type ChartSize, labelBudget, textWidth } from "@/components/charts/size";
import type { ChartTheme } from "@/lib/color/chart-theme";
import {
  type BoxSize,
  type GraphDirection,
  graphLayout,
  type LayoutEdge,
} from "@/lib/graph/layout";
import { ICON_PATHS, type IconName } from "@/lib/graph/symbols";
import { type TidyInput, tidyTree } from "@/lib/graph/tidy-tree";

/**
 * A graph's nodes drawn as blocks (#649): one box per node, sized to its
 * name, the name (and on a second line its value) inside, an icon symbol
 * beside the name. What a box measures, and whether a panel has room for the
 * boxes at all in each layout, is here; `graph.ts` draws them.
 *
 * A box is as wide as its name, from {@link GRAPH_BLOCK_MIN_WIDTH} up to a
 * cap: {@link GRAPH_BLOCK_MAX_WIDTH} first, then narrower ones down to 96, and a name
 * past the cap is cut with an ellipsis (the tooltip and the screen-reader
 * table carry it whole). The values' line goes before the boxes narrow past
 * the second step. When no step fits, the graph is drawn as markers and the
 * panel says so (`graphNotice`): never boxes over boxes.
 *
 * Every rule here is pure and answers for no size (a test, an export) with
 * the widest boxes and their values, as `nodeLabels` does.
 */

/** The narrowest a box is drawn, however short its name. */
export const GRAPH_BLOCK_MIN_WIDTH = 56;
/** The widest a box is drawn; a longer name is cut with an ellipsis. */
export const GRAPH_BLOCK_MAX_WIDTH = 160;
/** A box's padding across and down, inside its edge. */
export const BLOCK_PAD = { x: 8, y: 5 } as const;
/** The gap between an icon and the name beside it. */
const ICON_GAP = 5;
/** The least room between two boxes beside each other. */
export const BLOCK_GAP = 14;
/** The least room between one layer (or level) of boxes and the next. */
export const BLOCK_LAYER_GAP = 40;
/** A tree branch's open-and-close knob, beyond its box's trailing edge. */
export const BLOCK_KNOB = { size: 8, gap: 4 } as const;
/** Room kept between the boxes and the panel's edge. */
export const BLOCK_EDGE = 6;
/** How far past their tightest a layout is spread to fill a large panel. */
const BLOCK_SPREAD_MAX = 2.5;

/** The box widths tried in turn, and whether with the values' line. */
const STEPS: readonly { cap: number; values: boolean }[] = [
  { cap: GRAPH_BLOCK_MAX_WIDTH, values: true },
  { cap: 128, values: true },
  { cap: GRAPH_BLOCK_MAX_WIDTH, values: false },
  { cap: 128, values: false },
  { cap: 96, values: false },
];

/** What a box writes: its name, its value as written, its icon. */
export interface BlockText {
  name: string;
  value?: string;
  icon?: IconName;
}

/** The icon's side in a box: the height of a line. */
export function iconPx(theme: ChartTheme): number {
  return blockLine(theme) - 1;
}

/** A box's size at a width cap, with or without its values' line. */
export function blockSize(
  theme: ChartTheme,
  text: BlockText,
  cap: number,
  values: boolean,
  lines: number,
): BoxSize {
  const px = theme.type.label;
  const icon = text.icon ? iconPx(theme) + ICON_GAP : 0;
  const content = Math.max(
    icon + textWidth(text.name, px),
    values && text.value !== undefined ? textWidth(text.value, px) : 0,
  );
  const width = Math.min(
    Math.max(GRAPH_BLOCK_MIN_WIDTH, Math.ceil(content) + 2 * BLOCK_PAD.x),
    Math.max(GRAPH_BLOCK_MIN_WIDTH, cap),
  );
  return { width, height: lines * blockLine(theme) + 2 * BLOCK_PAD.y };
}

/** The boxes at one step: every node's size, and whether values are written. */
export interface BlockStep {
  sizes: Map<string, BoxSize>;
  values: boolean;
}

/**
 * The first step whose boxes `fits` accepts, or undefined when none does
 * and the graph is drawn as markers. With no size the first step stands.
 * Every box of a graph is as tall as every other: two lines when any node
 * has a value written, one when none does.
 */
export function blockSteps<G>(
  theme: ChartTheme,
  texts: ReadonlyMap<string, BlockText>,
  size: ChartSize | undefined,
  fits: (step: BlockStep) => G | undefined,
): (BlockStep & { geometry: G }) | undefined {
  const anyValue = [...texts.values()].some((t) => t.value !== undefined);
  const tried = new Set<string>();
  for (const { cap, values: wanted } of STEPS) {
    const values = wanted && anyValue;
    const key = `${cap}:${values}`;
    if (tried.has(key)) continue;
    tried.add(key);
    const lines = values ? 2 : 1;
    const sizes = new Map(
      [...texts].map(([id, t]) => [id, blockSize(theme, t, cap, values, lines)]),
    );
    const step = { sizes, values };
    const geometry = fits(step);
    if (geometry !== undefined) return { ...step, geometry };
    if (!size) return undefined;
  }
  return undefined;
}

/** Whether a box of `need` pixels fits a panel `size` less `chrome`, both ways: the label budget for one. */
function fitsPanel(size: ChartSize | undefined, need: BoxSize, chrome: BoxSize): boolean {
  if (!size) return true;
  return (
    labelBudget(size, 1, { along: "width", need: need.width, chrome: chrome.width })
      .show &&
    labelBudget(size, 1, { along: "height", need: need.height, chrome: chrome.height })
      .show
  );
}

/** A directed graph's boxes, placed in pixels: where each center is, and the plot's box. */
export interface DagBlocks {
  /** Each node's center, in pixels from the plot's top left. */
  at: Map<string, { x: number; y: number }>;
  /** The plot: as wide and tall as the boxes need, spread up to the panel. */
  width: number;
  height: number;
}

/**
 * A directed graph's boxes laid out (#649): `graphLayout` with each box's
 * size, a gap between boxes in a layer and between layers, in pixels. They
 * fit when the layout's box fits the panel; then the centers are spread to
 * fill it (never the boxes), up to {@link BLOCK_SPREAD_MAX} times as far
 * apart, so a gap only ever grows.
 */
export function dagBlocks(
  ids: readonly string[],
  edges: readonly LayoutEdge[],
  direction: GraphDirection,
  step: BlockStep,
  size: ChartSize | undefined,
): DagBlocks | undefined {
  const sizeOf = (id: string) => step.sizes.get(id) ?? { width: 0, height: 0 };
  const layout = graphLayout(ids, edges, direction, {
    size: sizeOf,
    nodeGap: BLOCK_GAP,
    layerGap: BLOCK_LAYER_GAP,
  });
  if (layout.nodes.length === 0) return undefined;
  const axis = (key: "x" | "y", extent: "width" | "height") => {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    let edgeLo = Number.POSITIVE_INFINITY;
    let edgeHi = Number.NEGATIVE_INFINITY;
    for (const n of layout.nodes) {
      const half = sizeOf(n.id)[extent] / 2;
      lo = Math.min(lo, n[key]);
      hi = Math.max(hi, n[key]);
      edgeLo = Math.min(edgeLo, n[key] - half);
      edgeHi = Math.max(edgeHi, n[key] + half);
    }
    // The boxes past the centers at each end, which the spread leaves as they are.
    return { lo, span: hi - lo, before: lo - edgeLo, after: edgeHi - hi };
  };
  const x = axis("x", "width");
  const y = axis("y", "height");
  const need = {
    width: x.span + x.before + x.after,
    height: y.span + y.before + y.after,
  };
  const chrome = { width: 2 * BLOCK_EDGE, height: 2 * BLOCK_EDGE };
  if (!fitsPanel(size, need, chrome)) return undefined;
  const spread = (a: typeof x, room: number | undefined) => {
    if (a.span === 0 || room === undefined) return 1;
    return Math.min(BLOCK_SPREAD_MAX, Math.max(1, (room - a.before - a.after) / a.span));
  };
  const fx = spread(x, size && size.width - chrome.width);
  const fy = spread(y, size && size.height - chrome.height);
  const at = new Map(
    layout.nodes.map((n) => [
      n.id,
      { x: x.before + (n.x - x.lo) * fx, y: y.before + (n.y - y.lo) * fy },
    ]),
  );
  return {
    at,
    width: x.span * fx + x.before + x.after,
    height: y.span * fy + y.before + y.after,
  };
}

/** A tree node as the tree's blocks read it: its id, and what is under it. */
export interface BlockTreeNode extends TidyInput {
  id: string;
  children: readonly BlockTreeNode[];
}

/** Where a tree's boxes sit at the panel's edges: the series' margins, in pixels. */
export interface TreeBlocks {
  margins: { left: number; right: number; top: number; bottom: number };
  /**
   * A radial tree's way out from the middle at each node, in radians on the
   * screen, as ECharts places it: where a branch's knob goes.
   */
  angles?: Map<string, number>;
}

/**
 * Whether a tree's boxes fit (#649). ECharts' tree has no node gap to set:
 * it lays the tree out in its own units (`tidyTree`) and stretches them to
 * the series' box, the levels evenly. So the boxes fit when, at that
 * stretch, each level is the widest box of it and the next (or the tallest,
 * down) apart and any two of a level are their boxes and a gap apart, at
 * the nearest ECharts would part them: a reader may close any branch, and
 * ECharts lays the rest out again. The margins hold the boxes at the ends,
 * and a branch's knob.
 */
export function treeBlocks(
  root: BlockTreeNode,
  orient: string,
  step: BlockStep,
  size: ChartSize | undefined,
): TreeBlocks | undefined {
  const sizeOf = (id: string) => step.sizes.get(id) ?? { width: 0, height: 0 };
  const radial = orient === "radial";
  const { places, span } = tidyTree(root, radial);
  const depths = Math.max(...places.map((p) => p.depth));
  const knob = BLOCK_KNOB.size + BLOCK_KNOB.gap;
  const all = places.map((p) => sizeOf(p.node.id));
  const widest = Math.max(...all.map((s) => s.width));
  const tallest = Math.max(...all.map((s) => s.height));
  const byDepth = new Map<number, typeof places>();
  for (const p of places) byDepth.set(p.depth, [...(byDepth.get(p.depth) ?? []), p]);
  // The nearest ECharts parts two nodes of a level, in its units: a unit
  // when two of them are siblings, two when none are.
  const parentOf = new Map<string, string>();
  const link = (n: BlockTreeNode) => {
    for (const c of n.children) {
      parentOf.set(c.id, n.id);
      link(c);
    }
  };
  link(root);
  const closestUnits = (depth: number) => {
    const parents = (byDepth.get(depth) ?? []).map((p) => parentOf.get(p.node.id));
    return new Set(parents).size < parents.length ? 1 : 2;
  };
  const levelMost = (depth: number, extent: "width" | "height") =>
    Math.max(0, ...(byDepth.get(depth) ?? []).map((p) => sizeOf(p.node.id)[extent]));

  if (radial) {
    const diagonal = Math.hypot(widest, tallest);
    const margin = diagonal / 2 + BLOCK_EDGE;
    const margins = { left: margin, right: margin, top: margin, bottom: margin };
    const turn = (2 * Math.PI) / span;
    // ECharts turns a tidy tree's units into a circle from the top, clockwise.
    const angles = new Map(places.map((p) => [p.node.id, p.x * turn - Math.PI / 2]));
    const fits = { margins, angles };
    if (!size) return fits;
    const radius = (Math.min(size.width, size.height) - 2 * margin) / 2;
    if (radius <= 0) return depths === 1 ? fits : undefined;
    const ring = radius / (depths - 1 || 1);
    if (depths > 1 && ring < diagonal + BLOCK_GAP + knob) return undefined;
    for (const [depth, level] of byDepth) {
      if (depth === 1 || level.length < 2) continue;
      const r = (depth - 1) * ring;
      // As near as ECharts parts two of a level, once a reader closes a branch.
      const closest = (closestUnits(depth) / depth) * turn;
      if (2 * r * Math.sin(Math.min(Math.PI, closest) / 2) < diagonal + BLOCK_GAP) {
        return undefined;
      }
    }
    return fits;
  }

  const sideways = orient === "LR" || orient === "RL";
  // Down a sideways tree runs across its levels; across it, down them.
  const along: "width" | "height" = sideways ? "width" : "height";
  const across: "width" | "height" = sideways ? "height" : "width";
  const first = levelMost(1, along) / 2 + BLOCK_EDGE;
  const last = levelMost(depths, along) / 2 + BLOCK_EDGE + knob;
  const end = (sideways ? tallest : widest) / 2 + BLOCK_EDGE;
  const lead = orient === "LR" || orient === "TB";
  const margins = sideways
    ? { left: lead ? first : last, right: lead ? last : first, top: end, bottom: end }
    : { left: end, right: end, top: lead ? first : last, bottom: lead ? last : first };
  if (!size) return { margins };
  const levels = sideways
    ? size.width - margins.left - margins.right
    : size.height - margins.top - margins.bottom;
  const breadth = sideways
    ? size.height - margins.top - margins.bottom
    : size.width - margins.left - margins.right;
  if (levels <= 0 || breadth <= 0) return undefined;
  const levelGap = levels / (depths - 1 || 1);
  for (let d = 1; d < depths; d++) {
    const need =
      (levelMost(d, along) + levelMost(d + 1, along)) / 2 + BLOCK_LAYER_GAP / 2 + knob;
    if (levelGap < need) return undefined;
  }
  const unit = breadth / span;
  for (const [depth, level] of byDepth) {
    if (level.length < 2) continue;
    // A reader can close any branch, which ECharts lays out again: then any
    // two of a level can be neighbors, as close as ECharts parts them.
    const [a = 0, b = 0] = level
      .map((p) => sizeOf(p.node.id)[across])
      .sort((x, y) => y - x);
    if (closestUnits(depth) * unit < (a + b) / 2 + BLOCK_GAP) return undefined;
  }
  return { margins };
}

/**
 * Whether a force graph's boxes fit (#649). ECharts' force layout pushes
 * nodes apart evenly in every direction, so at rest a cloud of boxes is
 * round, about {@link FORCE_CLOUD} times the square root of their count
 * times the largest box's diagonal (and a gap) across, as measured on
 * `graph-layout.md`. They fit while that is no wider than the panel's
 * shorter side, and each box fits the panel.
 */
export function forceBlocksFit(step: BlockStep, size: ChartSize | undefined): boolean {
  if (!size) return true;
  const boxes = [...step.sizes.values()];
  if (boxes.length === 0) return false;
  const room = { width: 2 * BLOCK_EDGE, height: 2 * BLOCK_EDGE };
  if (boxes.some((s) => !fitsPanel(size, s, room))) return false;
  const most = Math.max(...boxes.map(halfDiagonal));
  const across = FORCE_CLOUD * Math.sqrt(boxes.length) * (2 * most + BLOCK_GAP);
  return fitsPanel(size, { width: across, height: across }, room);
}

/** Half a box's diagonal: the radius a force graph's repulsion treats it as. */
export function halfDiagonal(s: BoxSize): number {
  return Math.hypot(s.width, s.height) / 2;
}

/** A cloud of boxes at rest, across, over √n times a box's diagonal and gap. */
const FORCE_CLOUD = 1.2;
/** Repulsion per pixel of a box's half-diagonal: what keeps boxes apart at rest. */
export const FORCE_REPULSION_PER_PX = 80;
/** The pull toward the middle that, against it, holds the cloud that size. */
export const FORCE_BLOCK_GRAVITY = 1;

/**
 * A force graph's spacing when its nodes are boxes (#649): ECharts pushes
 * two nodes apart by the sum of their repulsions over their distance, and
 * maps each node's value onto the repulsion's range, so each box's value is
 * its half-diagonal and the range runs over them, {@link
 * FORCE_REPULSION_PER_PX} a pixel; an edge is long enough for its two
 * largest boxes and a gap.
 */
export function forceBlockSpacing(sizes: Iterable<BoxSize>): {
  repulsion: [number, number];
  edgeLength: number;
  gravity: number;
} {
  const radii = [...sizes].map(halfDiagonal);
  const least = radii.length > 0 ? Math.min(...radii) : 0;
  const most = radii.length > 0 ? Math.max(...radii) : 0;
  return {
    repulsion: [
      Math.round(least * FORCE_REPULSION_PER_PX),
      Math.round(most * FORCE_REPULSION_PER_PX),
    ],
    edgeLength: Math.round(2 * most + BLOCK_GAP),
    gravity: FORCE_BLOCK_GRAVITY,
  };
}

/** A box's label as ECharts draws it: its name, an icon before it, its value under it. */
export function blockNodeLabel(
  theme: ChartTheme,
  fill: string,
  box: BoxSize,
  text: BlockText,
  values: boolean,
) {
  const style = nodeBlock(theme, fill, box.width - 2 * BLOCK_PAD.x, [
    BLOCK_PAD.y,
    BLOCK_PAD.x,
  ]);
  const icon = text.icon;
  const value = values && text.value !== undefined ? text.value : undefined;
  const line = icon ? `{i|}{g|}${text.name}` : text.name;
  return {
    ...style,
    rich: {
      ...style.rich,
      // The icon, in the box's ink, and the gap after it.
      i: {
        width: iconPx(theme),
        height: iconPx(theme),
        backgroundColor: icon ? { image: iconImage(icon, style.color) } : "transparent",
      },
      g: { width: ICON_GAP },
    },
    formatter: () => (value === undefined ? line : `${line}\n{v|${value}}`),
  };
}

/**
 * An icon as an image for a box's rich text: its one path from the
 * allowlist, filled in `ink`, as a data URL (never a URL a spec names).
 */
export function iconImage(icon: IconName, ink: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="${ink}" d="${ICON_PATHS[icon]}"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
