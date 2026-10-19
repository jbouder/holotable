import type { EChartsOption } from "echarts";
import {
  type ChartOptionBuilder,
  isNumeric,
  normalized,
  type PanelData,
  toNumber,
  toText,
} from "@/components/charts/options";
import { escapeHtml } from "@/components/charts/state-timeline";
import { type ChartTheme, inkOn, seriesColor } from "@/lib/color/chart-theme";
import type { Datum } from "@/lib/drilldown";
import { formatValue } from "@/lib/format";
import { echartsSymbol, type GraphSymbol, symbolSizeFor } from "@/lib/graph/symbols";
import { type Panel, panelTimeField } from "@/lib/ir";
import { GraphOptions } from "@/lib/panels/kinds/graph";
import { numberDisplay, readOptions } from "@/lib/panels/presentation";
import { CHART_TABLE_ROWS_MAX, type ChartRows } from "@/lib/panel-reading";
import type { TimeDisplay } from "@/lib/time-display";

/**
 * The graph kind (#623): what points at what, drawn as a tree.
 *
 * Two result shapes come in, and both leave as one tree of {@link GraphNode}s:
 *
 * - **Edges**, one row per parent → child, in `options.source` and
 *   `options.target` (by default the first two text columns). A repeated edge
 *   is one edge, its value summed; a node that is never a target is a root;
 *   a row with no parent declares one.
 * - **Path columns**, `options.path`, one row per leaf: the treemap's shape,
 *   with each node's value the sum of the leaves under it.
 *
 * The builder is pure and never throws on odd rows. Data that is not a tree
 * (a node with two parents, a cycle) comes back as a `problem` naming the
 * node, which the panel shows in its error state rather than drawing it
 * wrongly. That refusal lives in {@link graphTree}; the directed-graph layout
 * (#624) is where it becomes a fallback.
 *
 * Every node's label sits on its own color, in whichever ink reads on it
 * (`inkOn`), so `test/graph.test.ts` holds every series color to AA against
 * its label in both schemes, as the treemap's test does.
 */

/** The most nodes drawn; nodes past it (the deepest, then the latest) are left out. */
export const GRAPH_NODES_MAX = 500;

/** Joins a path into a node's id; a character no label contains. */
const SEP = "\u001f";
/** The id of the root drawn above several roots, which ECharts' tree needs. */
export const GRAPH_ROOT_ID = `${SEP}root`;

export interface GraphNode {
  name: string;
  /** The node's id in the chart: its name, or its path joined. */
  id: string;
  /** The incoming edge's value (edges), or the sum of the leaves under it (path). */
  value?: number;
  /** Its `options.group` value, which colors it and picks its symbol. */
  group?: string;
  /** The columns the node stands for: a datum's row. */
  row: Record<string, unknown>;
  children: GraphNode[];
}

export interface GraphTree {
  roots: GraphNode[];
  shape: "edges" | "path";
  /** The columns read: parent and child (edges) or the path, the value, the group. */
  sourceKey?: string;
  targetKey?: string;
  pathKeys: string[];
  valueKey?: string;
  groupKey?: string;
  /** The group values, in the order they color nodes. */
  groups: string[];
  /** Nodes past {@link GRAPH_NODES_MAX}, left out. */
  overflow: number;
  /** Why the rows are not a tree, naming the node; nothing is drawn then. */
  problem?: string;
}

/** The pieces both shapes are read into before they become a tree. */
interface Ingest {
  /** Every node, in the order the rows first name it. */
  order: string[];
  parent: Map<string, string>;
  name: (id: string) => string;
  value: Map<string, number>;
  group: Map<string, string>;
  row: (id: string) => Record<string, unknown>;
}

function empty(tree: Partial<GraphTree> & Pick<GraphTree, "shape">): GraphTree {
  return { roots: [], pathKeys: [], groups: [], overflow: 0, ...tree };
}

/** The rows as a tree, or why they are not one. Pure, and never throws on odd rows. */
export function graphTree(panel: Panel, data: PanelData): GraphTree {
  const o = readOptions(GraphOptions, panel.options);
  const timeField = panelTimeField(panel);
  const has = (c: string | undefined) =>
    c !== undefined && data.columns.includes(c) ? c : undefined;
  const valueKey = has(o.value);
  const groupKey = has(o.group);
  if (o.path) {
    const pathKeys = o.path.filter((c) => data.columns.includes(c));
    if (pathKeys.length === 0) return empty({ shape: "path", valueKey, groupKey });
    return assemble(
      ingestPath(data, pathKeys, valueKey, groupKey),
      empty({ shape: "path", pathKeys, valueKey, groupKey }),
    );
  }
  const text = data.columns.filter(
    (c) =>
      c !== timeField && c !== valueKey && c !== groupKey && !isNumeric(data.rows, c),
  );
  const sourceKey = has(o.source) ?? text[0];
  const targetKey = has(o.target) ?? text.find((c) => c !== sourceKey);
  const base = empty({ shape: "edges", sourceKey, targetKey, valueKey, groupKey });
  if (!sourceKey || !targetKey || sourceKey === targetKey) return base;
  const ingest = ingestEdges(data, sourceKey, targetKey, valueKey, groupKey);
  if (typeof ingest === "string") return { ...base, problem: ingest };
  return assemble(ingest, base);
}

/**
 * Edge rows: a child takes its first parent, and a second, different one is
 * the refusal. A self-edge is the shortest cycle.
 */
function ingestEdges(
  data: PanelData,
  sourceKey: string,
  targetKey: string,
  valueKey: string | undefined,
  groupKey: string | undefined,
): Ingest | string {
  const order: string[] = [];
  const seen = new Set<string>();
  const see = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  };
  const parent = new Map<string, string>();
  const value = new Map<string, number>();
  const group = new Map<string, string>();
  for (const row of data.rows) {
    const s = toText(row[sourceKey]);
    const t = toText(row[targetKey]);
    // A row with one end names a node with no parent: a root, or a leaf.
    const node = t || s;
    if (!node) continue;
    if (s && t) {
      if (s === t) return `"${t}" points at itself; a tree has no cycles`;
      see(s);
      see(t);
      const known = parent.get(t);
      if (known !== undefined && known !== s) {
        return `"${t}" has two parents ("${known}" and "${s}"); a tree needs one`;
      }
      parent.set(t, s);
    } else {
      see(node);
    }
    if (valueKey) {
      const v = toNumber(row[valueKey]);
      if (Number.isFinite(v)) value.set(node, (value.get(node) ?? 0) + v);
    }
    if (groupKey && !group.has(node)) {
      const g = toText(row[groupKey]);
      if (g) group.set(node, g);
    }
  }
  return {
    order,
    parent,
    name: (id) => id,
    value,
    group,
    row: (id) => {
      const p = parent.get(id);
      const row: Record<string, unknown> =
        p === undefined ? { [sourceKey]: id } : { [sourceKey]: p, [targetKey]: id };
      const v = value.get(id);
      if (valueKey && v !== undefined) row[valueKey] = v;
      const g = group.get(id);
      if (groupKey && g !== undefined) row[groupKey] = g;
      return row;
    },
  };
}

/** Path rows, as the treemap reads them: a parent is the sum of its leaves. */
function ingestPath(
  data: PanelData,
  pathKeys: string[],
  valueKey: string | undefined,
  groupKey: string | undefined,
): Ingest {
  const order: string[] = [];
  const labels = new Map<string, string[]>();
  const parent = new Map<string, string>();
  const value = new Map<string, number>();
  const group = new Map<string, string>();
  for (const row of data.rows) {
    const path = pathKeys.map((k) => toText(row[k]) || "(none)");
    const v = valueKey ? toNumber(row[valueKey]) : Number.NaN;
    let above: string | undefined;
    path.forEach((_, depth) => {
      const id = path.slice(0, depth + 1).join(SEP);
      if (!labels.has(id)) {
        labels.set(id, path.slice(0, depth + 1));
        order.push(id);
        if (above !== undefined) parent.set(id, above);
      }
      if (Number.isFinite(v)) value.set(id, (value.get(id) ?? 0) + v);
      above = id;
    });
    const leaf = path.join(SEP);
    if (groupKey && !group.has(leaf)) {
      const g = toText(row[groupKey]);
      if (g) group.set(leaf, g);
    }
  }
  return {
    order,
    parent,
    name: (id) => labels.get(id)?.at(-1) ?? id,
    value,
    group,
    row: (id) => {
      const path = labels.get(id) ?? [];
      const row: Record<string, unknown> = Object.fromEntries(
        path.map((label, i) => [pathKeys[i], label]),
      );
      const v = value.get(id);
      if (valueKey && v !== undefined) row[valueKey] = v;
      return row;
    },
  };
}

/**
 * Nodes into a tree, roots first and breadth first, up to the cap. A node no
 * root reaches is on a cycle, and the walk up from it finds one to name.
 */
function assemble(ingest: Ingest, base: GraphTree): GraphTree {
  const children = new Map<string, string[]>();
  for (const id of ingest.order) {
    const p = ingest.parent.get(id);
    if (p !== undefined) children.set(p, [...(children.get(p) ?? []), id]);
  }
  const roots = ingest.order.filter((id) => !ingest.parent.has(id));
  const reached: string[] = [...roots];
  for (let i = 0; i < reached.length; i++) {
    reached.push(...(children.get(reached[i] as string) ?? []));
  }
  if (reached.length < ingest.order.length) {
    const reachedSet = new Set(reached);
    const stray = ingest.order.find((id) => !reachedSet.has(id)) as string;
    const walked = new Set<string>();
    let at: string | undefined = stray;
    while (at !== undefined && !walked.has(at)) {
      walked.add(at);
      at = ingest.parent.get(at);
    }
    const name = ingest.name(at ?? stray);
    return { ...base, problem: `"${name}" is on a cycle; a tree has none` };
  }

  const kept = new Set(reached.slice(0, GRAPH_NODES_MAX));
  const groups: string[] = [];
  const build = (id: string): GraphNode => {
    const g = ingest.group.get(id);
    if (g !== undefined && !groups.includes(g)) groups.push(g);
    const own = ingest.value.get(id);
    const kids = (children.get(id) ?? []).filter((c) => kept.has(c));
    const node: GraphNode = {
      name: ingest.name(id),
      id,
      row: ingest.row(id),
      children: [],
      ...(g !== undefined ? { group: g } : {}),
    };
    node.children = kids.map(build);
    // A root of an edge list has no edge in: it shows what leaves it.
    const value =
      own ??
      (base.shape === "edges" && !ingest.parent.has(id)
        ? sumOf(node.children)
        : undefined);
    if (value !== undefined) node.value = value;
    return node;
  };
  return {
    ...base,
    roots: roots.filter((r) => kept.has(r)).map(build),
    groups,
    overflow: ingest.order.length - kept.size,
  };
}

function sumOf(nodes: GraphNode[]): number | undefined {
  const values = nodes.map((n) => n.value).filter((v) => v !== undefined);
  return values.length === 0 ? undefined : values.reduce((a, b) => a + b, 0);
}

/** Every node of the tree, parents before children. */
export function graphNodes(tree: GraphTree): GraphNode[] {
  const out: GraphNode[] = [];
  const walk = (nodes: GraphNode[]) => {
    for (const n of nodes) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(tree.roots);
  return out;
}

/** Why the panel cannot draw these rows, for its error state. */
export function graphProblem(panel: Panel, data: PanelData): string | undefined {
  return graphTree(panel, data).problem;
}

/** A node as a datum (#373): the columns it stands for, its name the series. */
export function graphDatum(node: GraphNode): Datum {
  return { row: node.row, series: node.name };
}

/** A layout or orientation change remounts; a data update merges (invariant 11). */
export function graphShape(panel: Panel): string {
  const o = readOptions(GraphOptions, panel.options);
  return JSON.stringify([o.layout ?? "tree", o.orient ?? "LR"]);
}

/**
 * The tree's edges as the screen-reader table (#77): one row per edge,
 * parent, child and value, each offering the child's datum links.
 */
export function graphTable(
  panel: Panel,
  data: PanelData,
  _display?: TimeDisplay,
): ChartRows {
  const tree = graphTree(panel, data);
  const o = readOptions(GraphOptions, panel.options);
  const display = numberDisplay(o);
  const edges: [GraphNode, GraphNode][] = [];
  const walk = (node: GraphNode) => {
    for (const child of node.children) {
      edges.push([node, child]);
      walk(child);
    }
  };
  for (const root of tree.roots) walk(root);
  const shown = edges.slice(0, CHART_TABLE_ROWS_MAX);
  const columns =
    tree.shape === "edges"
      ? [tree.sourceKey ?? "parent", tree.targetKey ?? "child"]
      : ["parent", "child"];
  if (tree.valueKey) columns.push(tree.valueKey);
  const count =
    shown.length === edges.length
      ? `${edges.length} ${edges.length === 1 ? "edge" : "edges"}`
      : `the first ${shown.length} of ${edges.length} edges`;
  return {
    caption: `Edges of ${panel.title}: ${count}.`,
    columns,
    rows: shown.map(([parent, child]) => [
      parent.name,
      child.name,
      ...(tree.valueKey
        ? [
            child.value === undefined
              ? ""
              : formatValue(child.value, panel.format, display),
          ]
        : []),
    ]),
    datums: shown.map(([, child]) => graphDatum(child)),
  };
}

/** Where a label sits beside its node, per orientation. */
function labelPosition(orient: string, leaf: boolean): string | undefined {
  switch (orient) {
    case "LR":
      return leaf ? "right" : "left";
    case "RL":
      return leaf ? "left" : "right";
    case "radial":
      return undefined;
    default:
      return "right";
  }
}

/** Room around the tree for the labels at its ends. */
function margins(orient: string) {
  switch (orient) {
    case "LR":
      return { left: "14%", right: "22%", top: 12, bottom: 12 };
    case "RL":
      return { left: "22%", right: "14%", top: 12, bottom: 12 };
    case "radial":
      return { left: "16%", right: "16%", top: "16%", bottom: "16%" };
    default:
      return { left: 16, right: "22%", top: 24, bottom: 24 };
  }
}

/** A node's color: its group's, or its branch's. */
function colorer(tree: GraphTree, theme: ChartTheme) {
  if (tree.groups.length > 0) {
    return (node: GraphNode, _branch: number) =>
      node.group === undefined
        ? seriesColor(theme, tree.groups.length)
        : seriesColor(theme, tree.groups.indexOf(node.group));
  }
  return (_node: GraphNode, branch: number) => seriesColor(theme, branch);
}

/** The one node drawn for rows with no tree in them: invisible, and no datum. */
const NOTHING = {
  id: GRAPH_ROOT_ID,
  name: "",
  text: "",
  symbol: "none",
  label: { show: false },
};

export const graphChart: ChartOptionBuilder = normalized((panel, data, { theme }) => {
  const tree = graphTree(panel, data);
  const o = readOptions(GraphOptions, panel.options);
  const orient = o.orient ?? "LR";
  const display = numberDisplay(o);
  const text = (v: number) => formatValue(v, panel.format, display);
  const colorOf = colorer(tree, theme);
  const symbolOf = (node: GraphNode): GraphSymbol =>
    (node.group !== undefined ? o.symbols?.[node.group] : undefined) ??
    o.symbol ??
    "circle";
  const open = o.collapseDepth ?? Number.POSITIVE_INFINITY;

  // Without groups, a branch keeps one color down from where it starts: below
  // a lone root, each of its children starts one; among several, each root.
  const toItem = (
    node: GraphNode,
    depth: number,
    branch: number,
    split = false,
  ): Record<string, unknown> => {
    const color = colorOf(node, branch);
    const symbol = symbolOf(node);
    const leaf = node.children.length === 0;
    return {
      id: node.id,
      name: node.name,
      ...(node.value !== undefined ? { value: node.value } : {}),
      // The label's text, read by the formatter: the name, then the value.
      text: node.value === undefined ? node.name : `${node.name}  ${text(node.value)}`,
      group: node.group,
      symbol: echartsSymbol(symbol),
      symbolSize: symbolSizeFor(symbol, o.symbolSize),
      itemStyle: { color },
      label: {
        backgroundColor: color,
        color: inkOn(color),
        ...(labelPosition(orient, leaf) ? { position: labelPosition(orient, leaf) } : {}),
      },
      ...(!leaf && depth >= open ? { collapsed: true } : {}),
      ...(leaf
        ? {}
        : {
            children: node.children.map((c, i) =>
              toItem(c, depth + 1, split ? i + 1 : branch),
            ),
          }),
    };
  };

  // ECharts lays out one root: several are drawn under one named for the panel.
  const [only] = tree.roots;
  const root =
    tree.roots.length === 1 && only
      ? toItem(only, 0, 0, true)
      : {
          id: GRAPH_ROOT_ID,
          name: panel.title,
          text: panel.title,
          symbol: "circle",
          symbolSize: 6,
          itemStyle: { color: theme.line },
          label: { backgroundColor: "transparent", color: theme.text },
          children: tree.roots.map((r, i) => toItem(r, 0, i)),
        };

  return {
    backgroundColor: "transparent",
    tooltip: {
      trigger: "item",
      borderRadius: 0,
      formatter: (p: unknown) => {
        const { data: item, treeAncestors } = p as {
          data?: { id?: string; name?: string; value?: number; group?: string };
          treeAncestors?: { name?: string; data?: { id?: string } }[];
        };
        if (!item || item.id === GRAPH_ROOT_ID) return "";
        const path = (treeAncestors ?? [])
          .filter((a) => a.data?.id !== undefined && a.data.id !== GRAPH_ROOT_ID)
          .map((a) => a.name ?? "")
          .filter(Boolean)
          .join(" → ");
        const lines = [escapeHtml(path || item.name || "")];
        if (item.value !== undefined) lines.push(escapeHtml(text(item.value)));
        if (item.group) lines.push(escapeHtml(item.group));
        return lines.join("<br/>");
      },
    },
    // Always set, so a count that drops to zero clears rather than lingers.
    title: {
      text: tree.overflow > 0 ? `+${tree.overflow} more nodes not shown` : "",
      right: 0,
      bottom: 0,
      textStyle: { color: theme.text, fontSize: 11, fontWeight: "normal" },
    },
    series: [
      {
        type: "tree",
        ...margins(orient),
        layout: orient === "radial" ? "radial" : "orthogonal",
        ...(orient === "radial" ? {} : { orient }),
        roam: false,
        // Collapse is the symbol's to toggle and the label's click is a datum
        // (#373), so ECharts' own click-anywhere toggle is off: `EChart`
        // tells the two apart and keeps what a reader collapsed across polls.
        expandAndCollapse: false,
        symbolKeepAspect: true,
        // ECharts' tree cannot lay out no nodes at all (it throws), so rows
        // with no tree in them draw one node that shows nothing.
        data: tree.roots.length > 0 ? [root] : [NOTHING],
        itemStyle: { borderColor: theme.background, borderWidth: 1 },
        lineStyle: { color: theme.line, width: 1.5, curveness: 0.5 },
        label: {
          show: true,
          fontSize: 11,
          padding: [2, 4],
          borderRadius: 2,
          distance: 6,
          formatter: (p: unknown) => (p as { data?: { text?: string } }).data?.text ?? "",
        },
        emphasis: { focus: "descendant" },
      },
    ],
  } as EChartsOption;
});
