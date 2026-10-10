import type { EChartsOption } from "echarts";
import {
  type ChartOptionBuilder,
  isNumeric,
  normalized,
  type PanelData,
  toNumber,
  toText,
} from "@/components/charts/options";
import { contrastRatio, hexToRgb } from "@/lib/color/contrast";
import { chartPalette } from "@/lib/color/oklch";
import { formatValue } from "@/lib/format";
import { type Panel, panelTimeField } from "@/lib/ir";
import { TREEMAP_DEPTH_MAX, TreemapOptions } from "@/lib/panels/kinds/treemap";
import { numberDisplay, readOptions } from "@/lib/panels/presentation";

/**
 * The treemap kind (#404): what a whole is made of, level by level, as nested
 * rectangles or, as a sunburst, rings.
 *
 * Each row is a leaf at the end of its path; rows with the same path are
 * summed, and a parent is the sum of its children. Every node takes its
 * top-level ancestor's chart color, so a branch reads as one thing, and its
 * label is whichever of {@link TREEMAP_LABELS} reads better on that color:
 * `test/treemap.test.ts` holds every chart color to AA against its label.
 *
 * A click is a datum (#373), so it does not also zoom: there is no drill-in
 * and no breadcrumb, and the whole tree is always drawn.
 */

/** The label colors a node may take; the chart colors are one set in both themes. */
export const TREEMAP_LABELS = ["#000000", "#ffffff"] as const;

/** The label that reads better on a node's color. */
export function treemapLabel(color: string): string {
  const [dark, light] = TREEMAP_LABELS;
  const on = hexToRgb(color);
  return contrastRatio(hexToRgb(dark), on) >= contrastRatio(hexToRgb(light), on)
    ? dark
    : light;
}
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

const palette = chartPalette();

export const treemapChart: ChartOptionBuilder = normalized((panel, data) => {
  const tree = treemapTree(panel, data);
  const o = readOptions(TreemapOptions, panel.options);
  const display = numberDisplay(o);
  const text = (v: unknown) => formatValue(v, panel.format, display);
  // A parent's header band is drawn in its border color, so a parent's border
  // is its branch's color and its header label is the one that reads on it.
  const toItem = (node: TreeNode, color: string): Record<string, unknown> => ({
    id: node.id,
    name: node.name,
    value: node.value,
    itemStyle:
      node.children.length > 0
        ? { color, borderColor: color, borderWidth: 2, gapWidth: 2 }
        : { color },
    label: { color: treemapLabel(color) },
    upperLabel: { color: treemapLabel(color) },
    ...(node.children.length > 0
      ? { children: node.children.map((c) => toItem(c, color)) }
      : {}),
  });
  const items = tree.roots.map((root, i) =>
    toItem(root, palette[i % palette.length] ?? "#888888"),
  );
  const label = { fontSize: 11 };
  const tooltip = {
    trigger: "item" as const,
    borderRadius: 0,
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
      return `${path || name || ""}: ${text(value)}`;
    },
  };
  if (o.variant === "sunburst") {
    return {
      backgroundColor: "transparent",
      tooltip,
      series: [
        {
          type: "sunburst",
          radius: ["12%", "92%"],
          sort: undefined,
          nodeClick: false,
          data: items,
          label: { ...label, rotate: "radial", minAngle: 8 },
          itemStyle: { borderColor: "rgba(0,0,0,0.35)", borderWidth: 1 },
        },
      ],
    } satisfies EChartsOption;
  }
  return {
    backgroundColor: "transparent",
    tooltip,
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
        label: { ...label, show: true, formatter: "{b}" },
        upperLabel: { show: tree.pathKeys.length > 1, height: 18 },
        itemStyle: { borderColor: "rgba(0,0,0,0.35)", borderWidth: 1, gapWidth: 1 },
        // The first level is ECharts' own root: no border and no header band.
        levels: [
          { upperLabel: { show: false }, itemStyle: { borderWidth: 0, gapWidth: 2 } },
        ],
      },
    ],
  } satisfies EChartsOption;
});
