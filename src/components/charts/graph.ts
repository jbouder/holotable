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
import type { PanelNotice } from "@/components/panels/types";
import { type ChartTheme, inkOn, seriesColor } from "@/lib/color/chart-theme";
import { edgeLabel, pinnedLabel, shared, text, tooltip } from "@/components/charts/style";
import { type ChartSize, nodeLabels, textWidth } from "@/components/charts/size";
import type { Datum } from "@/lib/drilldown";
import { formatValue } from "@/lib/format";
import { type GraphDirection, graphLayout } from "@/lib/graph/layout";
import {
  echartsSymbol,
  type GraphSymbol,
  SYMBOL_SIZE_MIN,
  symbolSizeFor,
} from "@/lib/graph/symbols";
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
 * (a node with two parents, a cycle) comes back from {@link graphTree} as a
 * `problem` naming the node.
 *
 * The `dag` layout (#624) draws the same rows as a layered directed graph:
 * {@link graphNet} reads them as nodes and edges, any number of parents and
 * cycles allowed, and `graphLayout` (`src/lib/graph/layout.ts`) places them.
 * A `tree` whose rows are not a tree falls back to it, and says so through
 * {@link graphNotice} rather than refusing. The `force` layout (#625) draws
 * the same net as a relationship cloud, placed by ECharts' force layout.
 * {@link graphView} is where a panel's layout is decided; every export here
 * dispatches on it.
 *
 * Every node's label sits on its own color, in whichever ink reads on it
 * (`inkOn`), so `test/graph.test.ts` holds every series color to AA against
 * its label in both schemes, as the treemap's test does.
 */

/** The most nodes drawn; nodes past it (the deepest, then the latest) are left out. */
export const GRAPH_NODES_MAX = 500;
/** The most edges a directed graph draws; edges past it (the latest) are left out. */
export const GRAPH_EDGES_MAX = 1500;

/** Joins a path into a node's id; a character no label contains. */
export const GRAPH_SEP = "\u001f";
const SEP = GRAPH_SEP;
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

/** The columns a graph reads, by its options or by default. */
export interface GraphColumns {
  shape: "edges" | "path";
  sourceKey?: string;
  targetKey?: string;
  pathKeys: string[];
  valueKey?: string;
  groupKey?: string;
}

function graphColumns(panel: Panel, data: PanelData): GraphColumns {
  const o = readOptions(GraphOptions, panel.options);
  const timeField = panelTimeField(panel);
  const has = (c: string | undefined) =>
    c !== undefined && data.columns.includes(c) ? c : undefined;
  const valueKey = has(o.value);
  const groupKey = has(o.group);
  if (o.path) {
    const pathKeys = o.path.filter((c) => data.columns.includes(c));
    return { shape: "path", pathKeys, valueKey, groupKey };
  }
  const text = data.columns.filter(
    (c) =>
      c !== timeField && c !== valueKey && c !== groupKey && !isNumeric(data.rows, c),
  );
  const sourceKey = has(o.source) ?? text[0];
  const targetKey = has(o.target) ?? text.find((c) => c !== sourceKey);
  return { shape: "edges", sourceKey, targetKey, pathKeys: [], valueKey, groupKey };
}

/** Whether the columns name two different ends of an edge. */
function hasEnds(
  c: GraphColumns,
): c is GraphColumns & { sourceKey: string; targetKey: string } {
  return (
    c.sourceKey !== undefined && c.targetKey !== undefined && c.sourceKey !== c.targetKey
  );
}

/** The rows as a tree, or why they are not one. Pure, and never throws on odd rows. */
export function graphTree(panel: Panel, data: PanelData): GraphTree {
  const c = graphColumns(panel, data);
  const { valueKey, groupKey } = c;
  if (c.shape === "path") {
    if (c.pathKeys.length === 0) return empty({ shape: "path", valueKey, groupKey });
    return assemble(
      ingestPath(data, c.pathKeys, valueKey, groupKey),
      empty({ shape: "path", pathKeys: c.pathKeys, valueKey, groupKey }),
    );
  }
  const { sourceKey, targetKey } = c;
  const base = empty({ shape: "edges", sourceKey, targetKey, valueKey, groupKey });
  if (!hasEnds(c)) return base;
  const ingest = ingestEdges(data, c.sourceKey, c.targetKey, valueKey, groupKey);
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
  /** The first row each node is the child (or the only end) of. */
  const own = new Map<string, Record<string, unknown>>();
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
    if (!own.has(node)) own.set(node, row);
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
      // The other columns of the node's own row (a root that is only ever a
      // parent has none), then what the node is, over them.
      const row: Record<string, unknown> = { ...own.get(id) };
      if (p === undefined) {
        row[sourceKey] = id;
        delete row[targetKey];
      } else {
        row[sourceKey] = p;
        row[targetKey] = id;
      }
      const v = value.get(id);
      if (valueKey) {
        if (v !== undefined) row[valueKey] = v;
        else delete row[valueKey];
      }
      const g = group.get(id);
      if (groupKey && g !== undefined) row[groupKey] = g;
      return withNode(row, id, p, g, v);
    },
  };
}

/**
 * A node's datum row with what every node carries (#623), over any result
 * column of the same name: `node` (its name), and where it has them `parent`
 * (its parent's name), `group` and `value`. A link reads `{ column: "node" }`
 * on any graph, whatever its columns are called.
 */
function withNode(
  row: Record<string, unknown>,
  node: string,
  parent: string | undefined,
  group: string | undefined,
  value: number | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row, node };
  if (parent !== undefined) out.parent = parent;
  if (group !== undefined) out.group = group;
  if (value !== undefined) out.value = value;
  return out;
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
      const g = group.get(id);
      if (groupKey && g !== undefined) row[groupKey] = g;
      const p = parent.get(id);
      return withNode(row, path.at(-1) ?? id, p && labels.get(p)?.at(-1), g, v);
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
    if (value !== undefined) {
      node.value = value;
      // A root's value is worked out here, so its datum learns it here.
      if (!("value" in node.row)) node.row = { ...node.row, value };
    }
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

/** A node of a directed graph (#624): any number of parents, a cycle allowed. */
export interface GraphVertex {
  /** Its id in the chart: its name, or its path joined. */
  id: string;
  name: string;
  /** Its incoming edges' values summed; a node with none, its outgoing ones'. */
  value?: number;
  group?: string;
  /** Its parents' ids, in the order the rows first name them. */
  parents: string[];
  /** Its datum's row, as a tree node's, its first parent the `parent`. */
  row: Record<string, unknown>;
}

/** An edge, once however many rows name it, its value summed over them. */
export interface GraphEdge {
  /** Its id in the chart, which a click on it carries. */
  id: string;
  source: string;
  target: string;
  value?: number;
  /** The first row that names it, its value the sum: its datum's columns. */
  row: Record<string, unknown>;
}

/**
 * The rows as nodes and edges (#624), the shape every layout but the tree
 * draws: the edge normalization. A repeated edge is one, its value summed; a
 * self-edge is kept (the table lists it, the chart marks its node).
 */
export interface GraphNet extends GraphColumns {
  /** Roots first, breadth first, then any only a cycle reaches; up to the cap. */
  nodes: GraphVertex[];
  /** Between nodes kept, in the order the rows first name them; up to the cap. */
  edges: GraphEdge[];
  groups: string[];
  /** Nodes past {@link GRAPH_NODES_MAX}, left out with their edges. */
  overflow: number;
  /** Edges past {@link GRAPH_EDGES_MAX}, or to a node left out. */
  edgeOverflow: number;
}

/** The id an edge carries in the chart; no node's id starts with it. */
export function graphEdgeId(source: string, target: string): string {
  return `${SEP}edge${SEP}${source}${SEP}${target}`;
}

/** The rows as nodes and edges, whatever their shape. Pure, and never throws. */
export function graphNet(panel: Panel, data: PanelData): GraphNet {
  const c = graphColumns(panel, data);
  const base: GraphNet = {
    ...c,
    nodes: [],
    edges: [],
    groups: [],
    overflow: 0,
    edgeOverflow: 0,
  };
  if (c.shape === "path") {
    if (c.pathKeys.length === 0) return base;
    // Path rows are always a tree; its edges are the net's.
    const ingest = ingestPath(data, c.pathKeys, c.valueKey, c.groupKey);
    const edges = ingest.order.flatMap((id) => {
      const p = ingest.parent.get(id);
      if (p === undefined) return [];
      const value = ingest.value.get(id);
      const row = ingest.row(id);
      return [
        {
          id: graphEdgeId(p, id),
          source: p,
          target: id,
          ...(value !== undefined ? { value } : {}),
          row,
        },
      ];
    });
    const nodes = ingest.order.map((id) => {
      const p = ingest.parent.get(id);
      const value = ingest.value.get(id);
      const group = ingest.group.get(id);
      return {
        id,
        name: ingest.name(id),
        parents: p === undefined ? [] : [p],
        row: ingest.row(id),
        ...(value !== undefined ? { value } : {}),
        ...(group !== undefined ? { group } : {}),
      };
    });
    return capNet({ ...base, nodes, edges });
  }
  if (!hasEnds(c)) return base;
  return capNet({
    ...base,
    ...ingestNet(data, c.sourceKey, c.targetKey, c.valueKey, c.groupKey),
  });
}

/**
 * Edge rows as nodes and edges: the tree's reading without its refusals. The
 * Sankey (#625) reads its edge rows through it too.
 */
export function ingestNet(
  data: PanelData,
  sourceKey: string,
  targetKey: string,
  valueKey: string | undefined,
  groupKey: string | undefined,
): Pick<GraphNet, "nodes" | "edges"> {
  const order: string[] = [];
  const parents = new Map<string, string[]>();
  const see = (id: string) => {
    if (!parents.has(id)) {
      parents.set(id, []);
      order.push(id);
    }
  };
  const own = new Map<string, Record<string, unknown>>();
  const group = new Map<string, string>();
  /** Values that came in on a node: its incoming edges', or its own row's. */
  const inValue = new Map<string, number>();
  const outValue = new Map<string, number>();
  const edges = new Map<string, GraphEdge>();
  const add = (m: Map<string, number>, k: string, v: number) =>
    m.set(k, (m.get(k) ?? 0) + v);
  for (const row of data.rows) {
    const s = toText(row[sourceKey]);
    const t = toText(row[targetKey]);
    const node = t || s;
    if (!node) continue;
    const v = valueKey ? toNumber(row[valueKey]) : Number.NaN;
    if (s && t) {
      see(s);
      see(t);
      // A self-edge is an edge, not a parent: a node pointing only at itself
      // is still a root.
      const ps = parents.get(t) as string[];
      if (s !== t && !ps.includes(s)) ps.push(s);
      const id = graphEdgeId(s, t);
      const edge = edges.get(id) ?? { id, source: s, target: t, row };
      if (Number.isFinite(v)) {
        edge.value = (edge.value ?? 0) + v;
        add(outValue, s, v);
      }
      edges.set(id, edge);
    } else {
      see(node);
    }
    if (!own.has(node)) own.set(node, row);
    if (Number.isFinite(v)) add(inValue, node, v);
    if (groupKey && !group.has(node)) {
      const g = toText(row[groupKey]);
      if (g) group.set(node, g);
    }
  }
  const nodes = order.map((id): GraphVertex => {
    const ps = parents.get(id) as string[];
    const value = inValue.get(id) ?? (ps.length === 0 ? outValue.get(id) : undefined);
    const g = group.get(id);
    const first = ps[0];
    // As a tree node's row: its own row's columns, its first parent and itself.
    const row: Record<string, unknown> = { ...own.get(id) };
    if (first === undefined) {
      row[sourceKey] = id;
      delete row[targetKey];
    } else {
      row[sourceKey] = first;
      row[targetKey] = id;
    }
    if (valueKey) {
      if (value !== undefined) row[valueKey] = value;
      else delete row[valueKey];
    }
    if (groupKey && g !== undefined) row[groupKey] = g;
    return {
      id,
      name: id,
      parents: ps,
      row: withNode(row, id, first, g, value),
      ...(value !== undefined ? { value } : {}),
      ...(g !== undefined ? { group: g } : {}),
    };
  });
  return {
    nodes,
    edges: [...edges.values()].map((e) => ({
      ...e,
      row: {
        ...e.row,
        ...(valueKey && e.value !== undefined ? { [valueKey]: e.value } : {}),
      },
    })),
  };
}

/**
 * The net within its caps: roots first and breadth first, then what only a
 * cycle reaches, up to {@link GRAPH_NODES_MAX}; the edges between those, up
 * to {@link GRAPH_EDGES_MAX}.
 */
export function capNet(net: GraphNet): GraphNet {
  const children = new Map<string, string[]>();
  for (const e of net.edges) {
    children.set(e.source, [...(children.get(e.source) ?? []), e.target]);
  }
  const order: string[] = [];
  const reached = new Set<string>();
  const reach = (from: string) => {
    if (reached.has(from)) return;
    reached.add(from);
    order.push(from);
    for (let i = order.length - 1; i < order.length; i++) {
      for (const c of children.get(order[i] as string) ?? []) {
        if (!reached.has(c)) {
          reached.add(c);
          order.push(c);
        }
      }
    }
  };
  for (const n of net.nodes) if (n.parents.length === 0) reach(n.id);
  for (const n of net.nodes) reach(n.id);
  const kept = new Set(order.slice(0, GRAPH_NODES_MAX));
  const nodes = net.nodes.filter((n) => kept.has(n.id));
  const between = net.edges.filter((e) => kept.has(e.source) && kept.has(e.target));
  const edges = between.slice(0, GRAPH_EDGES_MAX);
  const groups: string[] = [];
  for (const n of nodes) {
    if (n.group !== undefined && !groups.includes(n.group)) groups.push(n.group);
  }
  return {
    ...net,
    nodes,
    edges,
    groups,
    overflow: net.nodes.length - nodes.length,
    edgeOverflow: net.edges.length - edges.length,
  };
}

/**
 * How a panel's rows are drawn (#624): as a tree when the layout is `tree`
 * (the default) and they are one; as a directed graph when the layout is
 * `dag`, or when a tree's rows are not a tree, with why as the `fallback`.
 * Every layout's builder, table, datum and notice dispatch here.
 */
export type GraphView =
  | { layout: "tree"; tree: GraphTree }
  | { layout: "dag"; net: GraphNet; direction: GraphDirection; fallback?: string }
  | { layout: "force"; net: GraphNet };

export function graphView(panel: Panel, data: PanelData): GraphView {
  const o = readOptions(GraphOptions, panel.options);
  const direction = graphDirection(o);
  // A cloud has no direction to keep and takes any edges: nothing falls back.
  if (o.layout === "force") return { layout: "force", net: graphNet(panel, data) };
  if (o.layout === "dag") return { layout: "dag", net: graphNet(panel, data), direction };
  const tree = graphTree(panel, data);
  if (tree.problem === undefined) return { layout: "tree", tree };
  return { layout: "dag", net: graphNet(panel, data), direction, fallback: tree.problem };
}

/** Which way a directed graph's layers run: its `direction`, else the tree's `orient`. */
function graphDirection(o: GraphOptions): GraphDirection {
  if (o.direction) return o.direction;
  return o.orient === "TB" || o.orient === "BT" ? "TB" : "LR";
}

/**
 * What the panel says beside its title when its tree fell back to a directed
 * graph (#624): why, naming the node. Nothing when it drew what it was asked.
 */
export function graphNotice(panel: Panel, data: PanelData): PanelNotice | undefined {
  const view = graphView(panel, data);
  if (view.layout !== "dag" || view.fallback === undefined) return undefined;
  return {
    label: "Not a tree",
    detail: `${view.fallback}, so it is drawn as a directed graph. Set the layout to "dag" to draw it that way on purpose.`,
  };
}

/** A node as a datum (#373): the columns it stands for, its name the series. */
export function graphDatum(node: GraphNode | GraphVertex): Datum {
  return { row: node.row, series: node.name };
}

/**
 * An edge as a datum (#624): its first row's columns, its value the sum, and
 * `source`, `target` and `value` over any of the same name. A reversed edge
 * (a cycle's) carries its real ends, not the way it was laid out.
 */
export function graphEdgeDatum(net: GraphNet, edge: GraphEdge): Datum {
  const name = (id: string) => net.nodes.find((n) => n.id === id)?.name ?? id;
  const source = name(edge.source);
  const target = name(edge.target);
  return {
    row: {
      ...edge.row,
      source,
      target,
      ...(edge.value !== undefined ? { value: edge.value } : {}),
    },
    series: `${source} → ${target}`,
  };
}

/**
 * What a click on the item with this id is (#373): a node's datum, or on a
 * directed graph an edge's. The root drawn above several roots is none.
 */
export function graphClickDatum(panel: Panel, data: PanelData, id: string): Datum | null {
  const view = graphView(panel, data);
  if (view.layout === "tree") {
    const node = graphNodes(view.tree).find((n) => n.id === id);
    return node ? graphDatum(node) : null;
  }
  const node = view.net.nodes.find((n) => n.id === id);
  if (node) return graphDatum(node);
  const edge = view.net.edges.find((e) => e.id === id);
  return edge ? graphEdgeDatum(view.net, edge) : null;
}

/**
 * A layout, orientation or direction change remounts; a data update merges
 * (invariant 11), and so does a tree falling back to a directed graph on a
 * poll, which ECharts takes as a new series in the same place.
 */
export function graphShape(panel: Panel): string {
  const o = readOptions(GraphOptions, panel.options);
  return JSON.stringify([o.layout ?? "tree", o.orient ?? "LR", o.direction ?? ""]);
}

/**
 * The graph's edges as the screen-reader table (#77): one row per edge,
 * parent, child and value, each offering the child's datum links. A directed
 * graph's rows also say each end's layer, since there position is meaning.
 */
export function graphTable(
  panel: Panel,
  data: PanelData,
  _display?: TimeDisplay,
): ChartRows {
  const view = graphView(panel, data);
  if (view.layout === "tree") return treeTable(panel, view.tree);
  if (view.layout === "force") return forceTable(panel, view.net);
  return dagTable(panel, view.net, view.direction);
}

/** How many edges, or the first so many of them, for a table's caption. */
function edgeCount(shown: number, total: number): string {
  return shown === total
    ? `${total} ${total === 1 ? "edge" : "edges"}`
    : `the first ${shown} of ${total} edges`;
}

/**
 * A force graph's table (#625): its edges and their values, each offering the
 * links of the node it reaches, as the other layouts' tables do. A cloud's
 * positions mean nothing, so nothing else is said.
 */
function forceTable(panel: Panel, net: GraphNet): ChartRows {
  const o = readOptions(GraphOptions, panel.options);
  const display = numberDisplay(o);
  const byId = new Map(net.nodes.map((n) => [n.id, n]));
  const shown = net.edges.slice(0, CHART_TABLE_ROWS_MAX);
  return {
    caption: `Edges of ${panel.title}: ${edgeCount(shown.length, net.edges.length)}.`,
    columns: edgeColumns(net),
    rows: shown.map((e) => [
      byId.get(e.source)?.name ?? e.source,
      byId.get(e.target)?.name ?? e.target,
      ...(net.valueKey
        ? [e.value === undefined ? "" : formatValue(e.value, panel.format, display)]
        : []),
    ]),
    datums: shown.map((e) => {
      const node = byId.get(e.target);
      return node ? graphDatum(node) : null;
    }),
    labels: shown.map((e) => byId.get(e.target)?.name ?? e.target),
  };
}

function treeTable(panel: Panel, tree: GraphTree): ChartRows {
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
  const columns = edgeColumns(tree);
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
    // A row's links are the child's, so they are named for it.
    labels: shown.map(([, child]) => child.name),
  };
}

/** Edge columns as the table heads them: the edge columns, or the path's. */
function edgeColumns(c: GraphColumns): string[] {
  const columns =
    c.shape === "edges"
      ? [c.sourceKey ?? "parent", c.targetKey ?? "child"]
      : ["parent", "child"];
  if (c.valueKey) columns.push(c.valueKey);
  return columns;
}

function dagTable(panel: Panel, net: GraphNet, direction: GraphDirection): ChartRows {
  const o = readOptions(GraphOptions, panel.options);
  const display = numberDisplay(o);
  const layout = graphLayout(
    net.nodes.map((n) => n.id),
    net.edges,
    direction,
  );
  const placed = new Map(layout.nodes.map((n) => [n.id, n.layer]));
  const back = new Set(
    layout.edges.filter((e) => e.reversed).map((e) => graphEdgeId(e.source, e.target)),
  );
  const byId = new Map(net.nodes.map((n) => [n.id, n]));
  const shown = net.edges.slice(0, CHART_TABLE_ROWS_MAX);
  const count =
    shown.length === net.edges.length
      ? `${net.edges.length} ${net.edges.length === 1 ? "edge" : "edges"}`
      : `the first ${shown.length} of ${net.edges.length} edges`;
  const layers = `${layout.layers} ${layout.layers === 1 ? "layer" : "layers"}`;
  const layerOf = (id: string) => ((placed.get(id) ?? 0) + 1).toString();
  return {
    caption: `Edges of ${panel.title}: ${count}, in ${layers}.`,
    columns: [...edgeColumns(net), "layers"],
    rows: shown.map((e) => [
      byId.get(e.source)?.name ?? e.source,
      byId.get(e.target)?.name ?? e.target,
      ...(net.valueKey
        ? [e.value === undefined ? "" : formatValue(e.value, panel.format, display)]
        : []),
      e.source === e.target
        ? `${layerOf(e.source)}, to itself`
        : `${layerOf(e.source)} → ${layerOf(e.target)}${back.has(e.id) ? ", back edge" : ""}`,
    ]),
    // As the tree's: a row offers the links of the node it reaches.
    datums: shown.map((e) => {
      const node = byId.get(e.target);
      return node ? graphDatum(node) : null;
    }),
    labels: shown.map((e) => byId.get(e.target)?.name ?? e.target),
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

export const graphChart: ChartOptionBuilder = normalized(
  (panel, data, { theme, size }) => {
    const view = graphView(panel, data);
    if (view.layout === "tree") return treeOption(panel, view.tree, theme, size);
    if (view.layout === "force") return forceOption(panel, view.net, theme, size);
    return dagOption(panel, view.net, view.direction, theme, size);
  },
);

/** The longest of a graph's labels, with its value and without (#643). */
function widestLabels(items: readonly { text: string; short: string }[]) {
  const longest = (key: "text" | "short") =>
    items.reduce((a, b) => (b[key].length > a.length ? b[key] : a), "");
  return { widest: longest("text"), widestName: longest("short") };
}

/** A label's text: the name and value, or the name alone where only it fits. */
function labelText(values: boolean) {
  return (p: unknown) => {
    const d = (p as { data?: { text?: string; short?: string } }).data;
    return (values ? d?.text : d?.short) ?? "";
  };
}

/** A tree's layout as rows and columns: its depth, and its leaves. */
function treeExtent(roots: readonly GraphNode[]): { levels: number; leaves: number } {
  let levels = 0;
  let leaves = 0;
  const visit = (node: GraphNode, depth: number) => {
    levels = Math.max(levels, depth + 1);
    if (node.children.length === 0) leaves++;
    for (const child of node.children) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, roots.length > 1 ? 1 : 0);
  return { levels, leaves };
}

/** The symbol a node is drawn with: its group's, the default, or a circle. */
function symbolFor(o: GraphOptions, group: string | undefined): GraphSymbol {
  return (group !== undefined ? o.symbols?.[group] : undefined) ?? o.symbol ?? "circle";
}

/** Nodes past a cap, said in the corner; always set, so a count that drops clears. */
function overflowTitle(theme: ChartTheme, nodes: number, edges = 0) {
  const parts = [
    ...(nodes > 0 ? [`+${nodes} more ${nodes === 1 ? "node" : "nodes"}`] : []),
    ...(edges > 0 ? [`+${edges} more ${edges === 1 ? "edge" : "edges"}`] : []),
  ];
  return {
    text: parts.length > 0 ? `${parts.join(", ")} not shown` : "",
    right: 0,
    bottom: 0,
    textStyle: { ...text(theme), fontWeight: "normal" as const },
  };
}

function treeOption(
  panel: Panel,
  tree: GraphTree,
  theme: ChartTheme,
  size: ChartSize | undefined,
): EChartsOption {
  const o = readOptions(GraphOptions, panel.options);
  const orient = o.orient ?? "LR";
  const display = numberDisplay(o);
  const text = (v: number) => formatValue(v, panel.format, display);
  const colorOf = colorer(tree, theme);
  const symbolOf = (node: GraphNode): GraphSymbol => symbolFor(o, node.group);
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
      short: node.name,
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
          short: panel.title,
          symbol: "circle",
          symbolSize: 6,
          itemStyle: { color: theme.line },
          label: { backgroundColor: "transparent", color: theme.text },
          children: tree.roots.map((r, i) => toItem(r, 0, i)),
        };

  // Whether the labels fit the tree's levels and leaves at this size (#643):
  // across the levels and down the leaves, or the other way when it runs
  // down, or round the circle when it is radial.
  const extent = treeExtent(tree.roots);
  const all: { text: string; short: string }[] = [];
  const gather = (node: GraphNode) => {
    all.push({
      text: node.value === undefined ? node.name : `${node.name}  ${text(node.value)}`,
      short: node.name,
    });
    node.children.forEach(gather);
  };
  tree.roots.forEach(gather);
  const sideways = orient === "LR" || orient === "RL";
  const round = size && {
    width: Math.min(size.width, size.height),
    height: Math.PI * Math.min(size.width, size.height) * 0.68,
  };
  const fit = nodeLabels(orient === "radial" ? round : size, {
    across:
      orient === "radial" ? extent.levels * 2 : sideways ? extent.levels : extent.leaves,
    down: orient === "radial" || sideways ? extent.leaves : extent.levels,
    ...widestLabels(all),
    textPx: theme.type.label,
  });

  return {
    ...shared(theme),
    tooltip: {
      ...tooltip(theme),
      trigger: "item",
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
    title: overflowTitle(theme, tree.overflow),
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
        // Labels that do not fit show on the node under the pointer (#643).
        label: {
          show: fit.show,
          ...pinnedLabel(theme, fit.small),
          distance: 6,
          formatter: labelText(fit.values),
        },
        labelLayout: { hideOverlap: true },
        emphasis: { focus: "descendant", label: { show: true } },
      },
    ],
  } as EChartsOption;
}

/** The thinnest and widest an edge is drawn, by its value against the largest. */
const EDGE_WIDTH = [1, 6] as const;
/** How far a curved edge bows, and a reversed (cycle) edge, so it reads as one. */
const CURVENESS = 0.1;
const BACK_CURVENESS = 0.4;

/**
 * A directed graph (#624): an ECharts `graph` series with `layout: "none"`,
 * placed by `graphLayout`, an arrow on each edge, its width from its value,
 * a cycle's reversed edge dashed and bowed. A self-edge is not drawn
 * (ECharts draws none); its node's label says it with a ↻.
 *
 * The nodes sit on hidden value axes rather than ECharts' own `view`, which
 * scales a node's symbol by the width alone and so squashes it in a panel
 * whose shape is not the layout's. Pan and zoom, since a wide dependency
 * graph does not fit a panel, are the axes' inside zoom: drag to pan, pinch
 * or Ctrl and the wheel to zoom, so the page still scrolls past the panel.
 */
function dagOption(
  panel: Panel,
  net: GraphNet,
  direction: GraphDirection,
  theme: ChartTheme,
  size: ChartSize | undefined,
): EChartsOption {
  const o = readOptions(GraphOptions, panel.options);
  const display = numberDisplay(o);
  const text = (v: number) => formatValue(v, panel.format, display);
  const layout = graphLayout(
    net.nodes.map((n) => n.id),
    net.edges,
    direction,
  );
  const placed = new Map(layout.nodes.map((n) => [n.id, n]));
  const back = new Set(
    layout.edges.filter((e) => e.reversed).map((e) => graphEdgeId(e.source, e.target)),
  );
  const loops = new Set(
    net.edges.filter((e) => e.source === e.target).map((e) => e.source),
  );
  const byId = new Map(net.nodes.map((n) => [n.id, n]));
  const nameOf = (id: string) => byId.get(id)?.name ?? id;
  const colorOf = (node: GraphVertex) =>
    seriesColor(
      theme,
      node.group === undefined ? net.groups.length : net.groups.indexOf(node.group),
    );
  const widest = Math.max(0, ...net.edges.map((e) => Math.abs(e.value ?? 0)));
  const widthOf = (e: GraphEdge) =>
    widest > 0 && e.value !== undefined
      ? EDGE_WIDTH[0] + ((EDGE_WIDTH[1] - EDGE_WIDTH[0]) * Math.abs(e.value)) / widest
      : 1.5;
  const curve = o.curve ?? true;

  const nodes = net.nodes.map((node) => {
    const at = placed.get(node.id);
    const color = colorOf(node);
    const symbol = symbolFor(o, node.group);
    const name = loops.has(node.id) ? `${node.name} ↻` : node.name;
    return {
      id: node.id,
      name: node.name,
      // The place on the hidden axes; the node's own value is `amount`.
      value: [at?.x ?? 0, at?.y ?? 0],
      ...(node.value !== undefined ? { amount: node.value } : {}),
      text: node.value === undefined ? name : `${name}  ${text(node.value)}`,
      short: name,
      group: node.group,
      parents: node.parents.map(nameOf),
      loop: loops.has(node.id),
      symbol: echartsSymbol(symbol),
      symbolSize: symbolSizeFor(symbol, o.symbolSize),
      itemStyle: { color },
      label: { backgroundColor: color, color: inkOn(color) },
    };
  });
  const links = net.edges
    .filter((e) => e.source !== e.target)
    .map((e) => {
      const reversed = back.has(e.id);
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        ...(e.value !== undefined ? { value: e.value } : {}),
        reversed,
        lineStyle: {
          width: widthOf(e),
          ...(reversed
            ? { type: "dashed", curveness: BACK_CURVENESS }
            : { curveness: curve ? CURVENESS : 0 }),
        },
      };
    });

  // Whether the labels fit the layers at this size (#643): a layer is a
  // column when they run across, a row when they run down, and the most
  // nodes in one layer the other way. A label under a node (across) needs
  // the node's height as well as its line.
  const across = direction === "LR";
  const layers = new Map<number, number>();
  for (const n of layout.nodes) {
    const layer = across ? n.x : n.y;
    layers.set(layer, (layers.get(layer) ?? 0) + 1);
  }
  const most = Math.max(1, ...layers.values());
  const symbolPx = Math.max(0, ...nodes.map((n) => n.symbolSize));
  const fit = nodeLabels(size, {
    across: across ? layers.size : most,
    down: across ? most : layers.size,
    ...widestLabels(nodes),
    textPx: theme.type.label,
    line: across
      ? symbolPx + theme.type.label + 12
      : Math.max(symbolPx, theme.type.label + 8),
  });
  // The margins hold the labels at the layout's edges, by the width of the
  // widest one drawn: half of it either side under nodes, all of it beside.
  const drawn = fit.show
    ? textWidth(
        fit.values ? widestLabels(nodes).widest : widestLabels(nodes).widestName,
        theme.type.label - (fit.small ? 1 : 0),
      ) + 10
    : 0;
  const cap = (px: number) => Math.round(Math.min((size?.width ?? 800) * 0.3, px));

  return {
    ...shared(theme),
    tooltip: netTooltip(theme, nameOf, text),
    title: overflowTitle(theme, net.overflow, net.edgeOverflow),
    // Room for the labels beside the nodes at the edges of the layout: below
    // them when the layers run across, to their right when they run down.
    grid: !size
      ? direction === "LR"
        ? { left: 56, right: 56, top: 20, bottom: 36 }
        : { left: 24, right: "18%", top: 20, bottom: 20 }
      : direction === "LR"
        ? {
            left: cap(Math.max(24, drawn / 2 + 4)),
            right: cap(Math.max(24, drawn / 2 + 4)),
            top: 20,
            bottom: fit.show ? 36 : 20,
          }
        : { left: 24, right: cap(Math.max(24, drawn + 8)), top: 20, bottom: 20 },
    // Hidden: they only place the nodes. The first layer, and the first node
    // of a layer, at the top.
    xAxis: { type: "value", show: false, min: "dataMin", max: "dataMax" },
    yAxis: { type: "value", show: false, min: "dataMin", max: "dataMax", inverse: true },
    dataZoom: [0, 1].map((axis) => ({
      type: "inside",
      ...(axis === 0 ? { xAxisIndex: 0 } : { yAxisIndex: 0 }),
      // A node panned out of view keeps its edges.
      filterMode: "none",
      zoomOnMouseWheel: "ctrl",
      moveOnMouseWheel: false,
      moveOnMouseMove: true,
    })),
    series: [
      {
        type: "graph",
        coordinateSystem: "cartesian2d",
        layout: "none",
        symbolKeepAspect: true,
        data: nodes,
        links,
        edgeSymbol: ["none", "arrow"],
        edgeSymbolSize: 8,
        itemStyle: { borderColor: theme.background, borderWidth: 1 },
        lineStyle: { color: theme.line, opacity: 0.9 },
        // Labels that do not fit show on the node under the pointer (#643).
        label: {
          show: fit.show,
          position: direction === "LR" ? "bottom" : "right",
          ...pinnedLabel(theme, fit.small),
          distance: 4,
          formatter: labelText(fit.values),
        },
        labelLayout: { hideOverlap: true },
        edgeLabel: {
          show: o.edgeLabels === true,
          ...edgeLabel(theme),
          formatter: (p: unknown) => {
            const v = (p as { data?: { value?: number } }).data?.value;
            return v === undefined ? "" : text(v);
          },
        },
        emphasis: {
          focus: "adjacency",
          label: { show: true },
          lineStyle: { opacity: 1 },
        },
      },
    ],
  } as EChartsOption;
}

/**
 * The tooltip of a graph drawn from its net, a dag's or a force graph's: an
 * edge's ends and value, a node's name, value, group and where it is from.
 */
function netTooltip(
  theme: ChartTheme,
  nameOf: (id: string) => string,
  text: (v: number) => string,
) {
  return {
    ...tooltip(theme),
    trigger: "item" as const,
    formatter: (p: unknown) => {
      const { dataType, data: item } = p as {
        dataType?: string;
        data?: {
          name?: string;
          source?: string;
          target?: string;
          value?: number;
          amount?: number;
          group?: string;
          parents?: string[];
          reversed?: boolean;
          loop?: boolean;
        };
      };
      if (!item) return "";
      const lines: string[] = [];
      if (dataType === "edge") {
        lines.push(`${nameOf(item.source ?? "")} → ${nameOf(item.target ?? "")}`);
        if (item.value !== undefined) lines.push(text(item.value));
        if (item.reversed) lines.push("Back edge: closes a cycle");
      } else {
        lines.push(item.name ?? "");
        if (item.amount !== undefined) lines.push(text(item.amount));
        if (item.group) lines.push(item.group);
        if (item.parents && item.parents.length > 0) {
          lines.push(`From ${item.parents.join(", ")}`);
        }
        if (item.loop) lines.push("Points at itself");
      }
      return lines.map(escapeHtml).join("<br/>");
    },
  };
}

/** Past this many nodes, a force graph's labels show on hover only (#625). */
export const FORCE_LABELS_MAX = 60;

/**
 * How hard a force graph's nodes push apart and how long its edges are, from
 * its node count (#625): a handful spread across the panel, hundreds pack
 * close enough to stay in it.
 */
export function forceSpacing(nodes: number): { repulsion: number; edgeLength: number } {
  const n = Math.max(1, nodes);
  const clamp = (v: number, lo: number, hi: number) =>
    Math.round(Math.min(hi, Math.max(lo, v)));
  return {
    repulsion: clamp(900 / Math.sqrt(n), 25, 350),
    edgeLength: clamp(210 / Math.sqrt(n), 15, 90),
  };
}

/** The most a force graph's node is drawn at, whatever its value and size. */
const FORCE_SYMBOL_MAX = 64;

/**
 * A force graph's node size (#625): with a value, by its area, from 60% of
 * the symbol's size for the smallest to twice it for the largest; without
 * one, the symbol's size.
 */
export function forceNodeSize(
  base: number,
  value: number | undefined,
  largest: number,
): number {
  if (value === undefined || !(largest > 0)) return base;
  const share = Math.sqrt(Math.max(0, value) / largest);
  const size = base * 0.6 + base * 1.4 * share;
  return Math.min(FORCE_SYMBOL_MAX, Math.max(SYMBOL_SIZE_MIN, Math.round(size)));
}

/**
 * A relationship cloud (#625): an ECharts `graph` series with ECharts' own
 * force layout, for edges whose direction says nothing, so no arrows. Nodes
 * are colored by group and sized by value; edges are as wide as their value.
 *
 * A force layout moves, and a poll is a merge (invariant 11), so the layout
 * must not start over on every one: `layoutAnimation: false` settles it in
 * one go rather than drifting in view, and ECharts keeps the positions it
 * settled on per node id on the series, which a merged option keeps, so a
 * poll starts from where the nodes are and only a new node is placed. Node
 * ids are the rows' own names, so they stay the same between polls; no node
 * carries `x` or `y`, which would pin it. The first layout starts from a
 * circle, not at random, so the same rows draw the same cloud.
 *
 * The view is ECharts' own, which scales symbols evenly here (a force layout
 * has no positions of its own to stretch to the panel, unlike the dag's);
 * drag pans, and Ctrl and the wheel or a pinch zooms (`EChart`'s
 * `attachCtrlZoom`), so the page still scrolls past the panel.
 */
function forceOption(
  panel: Panel,
  net: GraphNet,
  theme: ChartTheme,
  size: ChartSize | undefined,
): EChartsOption {
  const o = readOptions(GraphOptions, panel.options);
  const display = numberDisplay(o);
  const text = (v: number) => formatValue(v, panel.format, display);
  const loops = new Set(
    net.edges.filter((e) => e.source === e.target).map((e) => e.source),
  );
  const byId = new Map(net.nodes.map((n) => [n.id, n]));
  const nameOf = (id: string) => byId.get(id)?.name ?? id;
  const colorOf = (node: GraphVertex) =>
    seriesColor(
      theme,
      node.group === undefined ? net.groups.length : net.groups.indexOf(node.group),
    );
  const widest = Math.max(0, ...net.edges.map((e) => Math.abs(e.value ?? 0)));
  const widthOf = (e: GraphEdge) =>
    widest > 0 && e.value !== undefined
      ? EDGE_WIDTH[0] + ((EDGE_WIDTH[1] - EDGE_WIDTH[0]) * Math.abs(e.value)) / widest
      : 1.5;
  const largest = Math.max(0, ...net.nodes.map((n) => n.value ?? 0));
  const texts = net.nodes.map((node) => {
    const name = loops.has(node.id) ? `${node.name} ↻` : node.name;
    return {
      text: node.value === undefined ? name : `${name}  ${text(node.value)}`,
      short: name,
    };
  });
  // A force layout has no rows or columns: its labels fit while the panel
  // has room for each one about three times over, the cloud being uneven
  // (#643), and never past the cap.
  const room = (label: string, px: number) =>
    !size ||
    (size.width * size.height) / Math.max(1, net.nodes.length) >=
      3 * (textWidth(label, px) + 14) * (px + 8);
  const longest = widestLabels(texts);
  const px = theme.type.label;
  const fit =
    net.nodes.length > FORCE_LABELS_MAX
      ? { show: false, values: false, small: false }
      : room(longest.widest, px)
        ? { show: true, values: true, small: false }
        : room(longest.widestName, px - 1)
          ? { show: true, values: false, small: true }
          : { show: false, values: false, small: true };
  const label = {
    ...pinnedLabel(theme, fit.small),
    distance: 4,
    position: "right",
    formatter: labelText(fit.values),
  };

  const nodes = net.nodes.map((node) => {
    const color = colorOf(node);
    const symbol = symbolFor(o, node.group);
    const name = loops.has(node.id) ? `${node.name} ↻` : node.name;
    return {
      id: node.id,
      name: node.name,
      // The node's own value is `amount`: a `value` would weigh its repulsion.
      ...(node.value !== undefined ? { amount: node.value } : {}),
      text: node.value === undefined ? name : `${name}  ${text(node.value)}`,
      short: name,
      group: node.group,
      parents: node.parents.map(nameOf),
      loop: loops.has(node.id),
      symbol: echartsSymbol(symbol),
      symbolSize: forceNodeSize(
        symbolSizeFor(symbol, o.symbolSize),
        o.value === undefined ? undefined : node.value,
        largest,
      ),
      itemStyle: { color },
      label: { backgroundColor: color, color: inkOn(color) },
    };
  });
  const links = net.edges
    .filter((e) => e.source !== e.target)
    .map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      ...(e.value !== undefined ? { value: e.value } : {}),
      lineStyle: { width: widthOf(e) },
    }));

  return {
    ...shared(theme),
    tooltip: netTooltip(theme, nameOf, text),
    title: overflowTitle(theme, net.overflow, net.edgeOverflow),
    series: [
      {
        type: "graph",
        layout: "force",
        force: {
          ...forceSpacing(net.nodes.length),
          initLayout: "circular",
          gravity: 0.15,
          layoutAnimation: false,
        },
        left: 24,
        right: 24,
        top: 20,
        bottom: 20,
        roam: "move",
        draggable: false,
        symbolKeepAspect: true,
        data: nodes,
        links,
        edgeSymbol: ["none", "none"],
        itemStyle: { borderColor: theme.background, borderWidth: 1 },
        lineStyle: { color: theme.line, opacity: 0.7, curveness: 0 },
        // Past the cap, a label shows only on the node under the pointer.
        label: { show: fit.show, ...label },
        edgeLabel: {
          show: o.edgeLabels === true,
          ...edgeLabel(theme),
          formatter: (p: unknown) => {
            const v = (p as { data?: { value?: number } }).data?.value;
            return v === undefined ? "" : text(v);
          },
        },
        emphasis: {
          focus: "adjacency",
          label: { show: true },
          lineStyle: { opacity: 1 },
        },
      },
    ],
  } as EChartsOption;
}
