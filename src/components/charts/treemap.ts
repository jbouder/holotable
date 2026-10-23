import type { EChartsOption } from "echarts";
import {
  type ChartOptionBuilder,
  isNumeric,
  normalized,
  type PanelData,
  toNumber,
  toText,
} from "@/components/charts/options";
import {
  block,
  blockLine,
  blockValueLabel,
  headerLabel,
  shared,
  tooltip,
} from "@/components/charts/style";
import { textWidth } from "@/components/charts/size";
import { treemapCells } from "@/components/charts/treemap-layout";
import { type ChartTheme, inkOn, seriesColor, soften } from "@/lib/color/chart-theme";
import { rankShades } from "@/lib/color/shade";
import { formatValue } from "@/lib/format";
import { type Panel, panelTimeField } from "@/lib/ir";
import { TREEMAP_DEPTH_MAX, TreemapOptions } from "@/lib/panels/kinds/treemap";
import { numberDisplay, readOptions } from "@/lib/panels/presentation";

/**
 * The treemap kind (#404): what a whole is made of, level by level, as nested
 * rectangles or, as a sunburst, rings.
 *
 * Each row is a leaf at the end of its path; rows with the same path are
 * summed, and a parent is the sum of its children. A parent is a container
 * on the raised surface with its name and total as a header; its leaves
 * carry the branch's color, shaded by rank (`treemapFills`), and say their
 * name and value where it fits (#657). Every label is whichever ink reads
 * better on its fill (`inkOn`): `test/treemap.test.ts` holds every shade of
 * every series color, in every palette and scheme, to AA against its label.
 *
 * A click is a datum (#373), so it does not also zoom: there is no drill-in
 * and no breadcrumb, and the whole tree is always drawn.
 */

/** The label that reads better on a node's color. */
export const treemapLabel = inkOn;

/** The most leaves drawn; the smallest are left out past it. */
export const TREEMAP_LEAVES_MAX = 500;
/** Joins a path into a node's id; a character no label contains. */
const SEP = "\u001f";

export interface TreeNode {
  name: string;
  /** The path from the top level, joined: the node's id in the chart. */
  id: string;
  value: number;
  /** The node's column values, from the top level down to it. */
  path: Record<string, string>;
  children: TreeNode[];
}

export interface Tree {
  roots: TreeNode[];
  pathKeys: string[];
  valueKey?: string;
  /** Leaves past {@link TREEMAP_LEAVES_MAX}, left out. */
  overflow: number;
}

/** The rows as a tree. Pure, and never throws on odd rows. */
export function treemapTree(panel: Panel, data: PanelData): Tree {
  const o = readOptions(TreemapOptions, panel.options);
  const timeField = panelTimeField(panel);
  const valueKey =
    (o.value && data.columns.includes(o.value) ? o.value : undefined) ??
    data.columns.find((c) => c !== timeField && isNumeric(data.rows, c));
  const pathKeys = (
    o.path?.filter((c) => data.columns.includes(c)) ??
    data.columns.filter(
      (c) => c !== timeField && c !== valueKey && !isNumeric(data.rows, c),
    )
  ).slice(0, TREEMAP_DEPTH_MAX);
  if (valueKey === undefined || pathKeys.length === 0) {
    return { roots: [], pathKeys, valueKey, overflow: 0 };
  }

  // Sum the leaves first, so the cap drops the smallest, not the latest.
  const leaves = new Map<string, { labels: string[]; value: number }>();
  for (const row of data.rows) {
    const value = toNumber(row[valueKey]);
    if (!Number.isFinite(value) || value <= 0) continue;
    const labels = pathKeys.map((k) => toText(row[k]) || "(none)");
    const id = labels.join(SEP);
    const leaf = leaves.get(id) ?? { labels, value: 0 };
    leaf.value += value;
    leaves.set(id, leaf);
  }
  const kept = [...leaves.values()]
    .sort((a, b) => b.value - a.value)
    .slice(0, TREEMAP_LEAVES_MAX);

  const roots: TreeNode[] = [];
  for (const { labels, value } of kept) {
    let level = roots;
    labels.forEach((name, depth) => {
      const id = labels.slice(0, depth + 1).join(SEP);
      let node = level.find((n) => n.id === id);
      if (!node) {
        node = {
          name,
          id,
          value: 0,
          path: Object.fromEntries(
            pathKeys.slice(0, depth + 1).map((k, i) => [k, labels[i] ?? ""]),
          ),
          children: [],
        };
        level.push(node);
      }
      node.value += value;
      level = node.children;
    });
  }
  const order = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => b.value - a.value);
    for (const n of nodes) order(n.children);
  };
  order(roots);
  return { roots, pathKeys, valueKey, overflow: Math.max(0, leaves.size - kept.length) };
}

/** Every node of the tree, parents before children. */
export function treemapNodes(tree: Tree): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(tree.roots);
  return out;
}

/** A variant change remounts; a data update merges (invariant 11). */
export function treemapShape(panel: Panel): string {
  return JSON.stringify(panel.options ?? {});
}

/** What parts nodes: a region's inset and the gap between its members. */
export const TREEMAP_GUTTER = 3;
/** The gap of surface between top-level nodes. */
const ROOT_GAP = 4;
/** A label's padding inside its block. */
const LABEL_PAD = 5;
/** A header's padding across. */
const HEADER_PAD = 6;
/** The sunburst's rings, as fractions of its radius. */
const RING_INNER = 0.12;
const RING_OUTER = 0.92;

/** A region's header band: a line of label text and its padding. */
function headerHeight(theme: ChartTheme): number {
  return theme.type.label + 10;
}

/**
 * Every node's fill (#657). A treemap with levels draws its regions as
 * containers and gives the branch color to the leaves, each a step of it by
 * its rank within the branch, largest strongest, toward the container they
 * sit in; a sunburst keeps the branch color on its inner ring and shades each
 * ring after it by rank the same way. A one-level chart is one branch: its
 * nodes are shaded by rank from the first series color, so the rule is the
 * same at every depth, the fills never run out past the eighth series color,
 * and the strongest fill is the largest node, as its size already says.
 */
export function treemapFills(
  tree: Tree,
  theme: ChartTheme,
  variant: "treemap" | "sunburst" = "treemap",
): Map<string, string> {
  const fills = new Map<string, string>();
  const assign = (nodes: readonly TreeNode[], shades: readonly string[]) => {
    for (const [k, n] of nodes.entries()) fills.set(n.id, shades[k] ?? theme.background);
  };
  const flat = tree.roots.every((r) => r.children.length === 0);
  if (flat) {
    const shades = rankShades(
      soften(theme, seriesColor(theme, 0)),
      tree.roots.length,
      theme.background,
    );
    assign(byRank(tree.roots), shades);
    return fills;
  }
  tree.roots.forEach((root, i) => {
    const branch = soften(theme, seriesColor(theme, i));
    const below = treemapNodes({ ...tree, roots: [root] });
    if (variant === "sunburst") {
      fills.set(root.id, branch);
      // Ring by ring, a step in from the branch color, so a ring never
      // repeats the one inside it.
      for (let depth = 2; depth <= tree.pathKeys.length; depth++) {
        const ring = byRank(below.filter((n) => Object.keys(n.path).length === depth));
        const shades = rankShades(branch, ring.length + 1, theme.background).slice(1);
        assign(ring, shades);
      }
      return;
    }
    const leaves = byRank(below.filter((n) => n.children.length === 0));
    const shades = rankShades(branch, leaves.length, theme.container);
    assign(leaves, shades);
  });
  return fills;
}

/**
 * Nodes largest first, and of equal values the later one first, as ECharts
 * lays them out: a tie's strongest shade is then the one drawn first.
 */
function byRank(nodes: readonly TreeNode[]): TreeNode[] {
  return nodes
    .map((node, index) => ({ node, index }))
    .sort((a, b) => b.node.value - a.node.value || b.index - a.index)
    .map(({ node }) => node);
}

/**
 * A node's label as lines, longest first tried: its name and, under it, its
 * value with its share of its parent (of the whole, at the top), or its value
 * alone (or, on a sunburst's ring, its name alone). `fits` says whether a set of lines fits the node's block; when none
 * does, the label is empty, never cut.
 */
function nodeLabel(
  node: TreeNode,
  whole: number,
  write: (v: unknown) => string,
  fits: (lines: string[]) => boolean,
  nameAlone = false,
): string {
  const share = whole > 0 ? node.value / whole : 0;
  const pct = share < 0.01 ? "<1%" : `${Math.round(share * 100)}%`;
  const value = write(node.value);
  // An only child is all of its parent: its share says nothing.
  const tiers = share < 1 ? [[node.name, `${value} · ${pct}`]] : [];
  for (const lines of [...tiers, [node.name, value]]) {
    if (fits(lines)) return `${lines[0]}\n{v|${lines[1]}}`;
  }
  // A ring is thin by construction: a sunburst's node may say its name
  // alone, its value in the tooltip, before it says nothing.
  if (nameAlone && fits([node.name])) return node.name;
  return "";
}

/** The widest of `lines` drawn at `px`. */
function widest(lines: string[], px: number): number {
  return Math.max(...lines.map((l) => textWidth(l, px)));
}

export const treemapChart: ChartOptionBuilder = normalized(
  (panel, data, { theme, size }) => {
    const tree = treemapTree(panel, data);
    const o = readOptions(TreemapOptions, panel.options);
    const display = numberDisplay(o);
    const write = (v: unknown) => formatValue(v, panel.format, display);
    const sunburst = o.variant === "sunburst";
    const fills = treemapFills(tree, theme, sunburst ? "sunburst" : "treemap");
    const px = theme.type.label;
    const line = blockLine(theme);
    const levels = tree.pathKeys.length;
    const header = headerHeight(theme);
    const total = tree.roots.reduce((s, r) => s + r.value, 0);

    // Where each block is drawn, to know whether its label fits. With no
    // size (a test, an export before layout) every label is drawn.
    const cells =
      !sunburst && size
        ? treemapCells(tree.roots, size.width - 8, size.height - 8, {
            rootGap: ROOT_GAP,
            border: TREEMAP_GUTTER,
            gap: TREEMAP_GUTTER,
            header,
          })
        : undefined;
    const radius = size ? Math.min(size.width, size.height) / 2 : undefined;
    const ring = radius ? ((RING_OUTER - RING_INNER) * radius) / levels : 0;
    const fitsBlock = (node: TreeNode, depth: number) => (lines: string[]) => {
      if (sunburst) {
        if (!radius) return true;
        // Written along the radius: as long as the ring is thick, as tall as
        // the arc is wide at the ring's inner edge.
        const inner = radius * RING_INNER + ring * (depth - 1);
        const arc = (node.value / (total || 1)) * 2 * Math.PI * inner;
        return widest(lines, px) + 2 * 4 <= ring && lines.length * line + 2 <= arc;
      }
      const cell = cells?.get(node.id);
      if (!cells) return true;
      if (!cell) return false;
      return (
        widest(lines, px) + 2 * LABEL_PAD <= cell.width &&
        lines.length * line + 2 * LABEL_PAD <= cell.height
      );
    };
    const headerText = (node: TreeNode) => {
      const name = node.name;
      const sum = write(node.value);
      const cell = cells?.get(node.id);
      const room = cells
        ? cell
          ? cell.width - 2 * TREEMAP_GUTTER - 2 * HEADER_PAD
          : 0
        : Infinity;
      if (textWidth(`${name}  ${sum}`, px) <= room) return `${name}  {t|${sum}}`;
      if (textWidth(name, px) <= room) return name;
      return "";
    };
    const same = <T>(value: T) => ({ formatter: () => value });

    const toItem = (
      node: TreeNode,
      depth: number,
      whole: number,
    ): Record<string, unknown> => {
      const base = { id: node.id, name: node.name, value: node.value };
      const children = node.children.map((c) => toItem(c, depth + 1, node.value));
      if (!sunburst && node.children.length > 0) {
        // A region: a container on the raised surface (a region inside one
        // on the surface, so the two part), its header as text.
        const box = depth % 2 === 1 ? theme.container : theme.background;
        const text = headerText(node);
        return {
          ...base,
          itemStyle: {
            ...block(theme, { edge: TREEMAP_GUTTER }),
            color: box,
            borderColor: box,
            gapWidth: TREEMAP_GUTTER,
          },
          upperLabel: same(text),
          emphasis: {
            itemStyle: { borderColor: box, strokeColor: theme.ring, strokeWidth: 2 },
            upperLabel: same(text),
          },
          children,
        };
      }
      const fill = fills.get(node.id) ?? theme.background;
      const text = nodeLabel(node, whole, write, fitsBlock(node, depth), sunburst);
      return {
        ...base,
        itemStyle: sunburst ? { color: fill } : { color: fill, borderWidth: 0 },
        // A sunburst writes a node's name where its label is empty, so a
        // label that does not fit is not shown at all.
        label: { show: text !== "", color: inkOn(fill), ...same(text) },
        // Under the pointer, an outline in the ring color around the fill
        // as it is: ECharts would otherwise lighten it, under its label.
        emphasis: {
          itemStyle: sunburst
            ? { color: fill, borderColor: theme.ring, borderWidth: 2 }
            : { color: fill, strokeColor: theme.ring, strokeWidth: 2 },
          // The outline grows the block's box by half its width, which would
          // move a top-left label; a pixel more padding holds it in place.
          label: {
            show: text !== "",
            color: inkOn(fill),
            ...same(text),
            ...(sunburst ? {} : { padding: LABEL_PAD + 1 }),
          },
        },
        ...(children.length > 0 ? { children } : {}),
      };
    };
    const items = tree.roots.map((root) => toItem(root, 1, total));
    const tip = {
      ...tooltip(theme),
      trigger: "item" as const,
      formatter: (p: unknown) => {
        const { name, value, treePathInfo } = p as {
          name?: string;
          value?: unknown;
          treePathInfo?: { name: string }[];
        };
        const path = (treePathInfo ?? [])
          .map((s) => s.name)
          .filter(Boolean)
          .join(" / ");
        return `${path || name || ""}: ${write(value)}`;
      },
    };
    if (sunburst) {
      return {
        ...shared(theme),
        tooltip: tip,
        series: [
          {
            type: "sunburst",
            radius: [`${RING_INNER * 100}%`, `${RING_OUTER * 100}%`],
            sort: undefined,
            nodeClick: false,
            data: items,
            label: { ...blockValueLabel(theme), rotate: "radial", minAngle: 0 },
            // Rings part by a hair of surface, not a dark edge.
            itemStyle: block(theme, { edge: 2 }),
          },
        ],
      } satisfies EChartsOption;
    }
    return {
      ...shared(theme),
      tooltip: tip,
      series: [
        {
          type: "treemap",
          top: 4,
          left: 4,
          right: 4,
          bottom: 4,
          roam: false,
          nodeClick: false,
          breadcrumb: { show: false },
          data: items,
          // Top left: the name, and the value under it.
          label: {
            ...blockValueLabel(theme),
            show: true,
            position: "insideTopLeft",
            padding: LABEL_PAD,
          },
          upperLabel: {
            ...headerLabel(theme, header),
            show: levels > 1,
            height: header,
            padding: [0, HEADER_PAD],
          },
          // Nodes part by a gutter of surface, never an outline; the page's
          // corners, square unless the palette rounds.
          itemStyle: { ...block(theme, { edge: 0 }), gapWidth: TREEMAP_GUTTER },
          // The first level is ECharts' own root: regions part by the surface.
          levels: [
            {
              upperLabel: { show: false },
              itemStyle: {
                borderWidth: 0,
                borderColor: theme.background,
                gapWidth: ROOT_GAP,
              },
            },
          ],
        },
      ],
    } satisfies EChartsOption;
  },
);
