import type { EChartsOption } from "echarts";
import {
  capNet,
  GRAPH_SEP,
  type GraphEdge,
  type GraphNet,
  type GraphVertex,
  graphDatum,
  graphEdgeDatum,
  graphEdgeId,
  ingestNet,
} from "@/components/charts/graph";
import {
  type ChartOptionBuilder,
  isNumeric,
  normalize,
  normalized,
  type PanelData,
  toNumber,
  toText,
} from "@/components/charts/options";
import { escapeHtml } from "@/components/charts/state-timeline";
import type { PanelNotice } from "@/components/panels/types";
import { type ChartTheme, inkOn, seriesColor } from "@/lib/color/chart-theme";
import type { Datum } from "@/lib/drilldown";
import { formatValue } from "@/lib/format";
import { type Panel, panelTimeField } from "@/lib/ir";
import { SankeyOptions } from "@/lib/panels/kinds/sankey";
import { numberDisplay, readOptions } from "@/lib/panels/presentation";
import { CHART_TABLE_ROWS_MAX, type ChartRows } from "@/lib/panel-reading";
import type { TimeDisplay } from "@/lib/time-display";

/**
 * The Sankey kind (#625): how much flows where, as an ECharts `sankey`.
 *
 * Its rows are the graph's, read through the graph's edge normalization
 * (`ingestNet`, `capNet`): one row per edge, `options.source` →
 * `options.target`, a repeated edge one flow with its value summed; or path
 * columns, one stage per column. Unlike the graph's path, which is a tree, a
 * Sankey's stage is its column: `200` under every route is one node, so a
 * node's id is its column's place and its value, and two stages never share
 * a node even when they share a value.
 *
 * Two things a graph accepts a Sankey refuses, through the renderer's
 * `problem`: a cycle, named by a node on it (a Sankey flows one way, and
 * ECharts throws on one), and a value column the rows do not have. A row
 * whose value is not a positive number has no width to draw; it is left out
 * and the panel's notice counts it.
 *
 * Every node's label sits on its own color, in whichever ink reads on it
 * (`inkOn`), as the graph's do, and `test/sankey.test.ts` holds that.
 */

/** A Sankey's net, and what it could not draw. */
export interface SankeyNet extends GraphNet {
  /** Rows with both ends whose value is not a positive number, left out. */
  dropped: number;
  /** Why the rows cannot be drawn, naming what is wrong; nothing is then. */
  problem?: string;
  /** What enters and what leaves each node, summed over its flows, by id. */
  totals: Map<string, { in: number; out: number }>;
}

/** The rows as a Sankey's nodes and flows. Pure, and never throws on odd rows. */
export function sankeyNet(panel: Panel, raw: PanelData): SankeyNet {
  // Rows reach the notice and the table as they came, so they are read here.
  const data = normalize(raw);
  const o = readOptions(SankeyOptions, panel.options);
  const has = (c: string | undefined) =>
    c !== undefined && data.columns.includes(c) ? c : undefined;
  const valueKey = has(o.value);
  const groupKey = has(o.group);
  const empty: SankeyNet = {
    shape: o.path ? "path" : "edges",
    pathKeys: [],
    valueKey,
    groupKey,
    nodes: [],
    edges: [],
    groups: [],
    overflow: 0,
    edgeOverflow: 0,
    dropped: 0,
    totals: new Map(),
  };
  // No rows yet: nothing to draw, and nothing wrong.
  if (data.columns.length === 0) return empty;
  if (o.value !== undefined && valueKey === undefined) {
    return {
      ...empty,
      problem: `The value column "${o.value}" is not in the rows; a Sankey needs a volume on every flow`,
    };
  }
  if (valueKey === undefined) return empty;

  let net: GraphNet;
  let dropped = 0;
  const positive = (row: Record<string, unknown>) => {
    const v = toNumber(row[valueKey]);
    return Number.isFinite(v) && v > 0;
  };
  if (o.path) {
    const pathKeys = o.path.filter((c) => data.columns.includes(c));
    if (pathKeys.length < 2) return { ...empty, pathKeys };
    const rows = data.rows.filter((row) => {
      if (positive(row)) return true;
      dropped++;
      return false;
    });
    net = capNet({
      ...empty,
      pathKeys,
      ...ingestStages(rows, pathKeys, valueKey, groupKey),
    });
  } else {
    const timeField = panelTimeField(panel);
    const text = data.columns.filter(
      (c) =>
        c !== timeField && c !== valueKey && c !== groupKey && !isNumeric(data.rows, c),
    );
    const sourceKey = has(o.source) ?? text[0];
    const targetKey = has(o.target) ?? text.find((c) => c !== sourceKey);
    const base = { ...empty, sourceKey, targetKey };
    if (!sourceKey || !targetKey || sourceKey === targetKey) return base;
    // Only rows with both ends and a volume are flows.
    const rows = data.rows.filter((row) => {
      if (!toText(row[sourceKey]) || !toText(row[targetKey])) return false;
      if (positive(row)) return true;
      dropped++;
      return false;
    });
    net = capNet({
      ...base,
      ...ingestNet(
        { columns: data.columns, rows },
        sourceKey,
        targetKey,
        valueKey,
        groupKey,
      ),
    });
  }

  const totals = new Map<string, { in: number; out: number }>();
  const total = (id: string) => {
    const t = totals.get(id) ?? { in: 0, out: 0 };
    totals.set(id, t);
    return t;
  };
  for (const e of net.edges) {
    total(e.source).out += e.value ?? 0;
    total(e.target).in += e.value ?? 0;
  }
  // A node's value is what passes through it: the larger of in and out, as
  // ECharts sizes it. A Sankey node has no one parent, so its datum names none.
  const nodes = net.nodes.map((n): GraphVertex => {
    const t = total(n.id);
    const value = Math.max(t.in, t.out);
    const { parent: _parent, ...row } = n.row;
    return { ...n, value, row: { ...row, [valueKey]: value, value } };
  });
  const out: SankeyNet = { ...net, nodes, dropped, totals };
  const cycle = findCycle(out);
  return cycle ? { ...out, problem: cycle } : out;
}

/**
 * Path rows as stages: each column's values are its stage's nodes, a flow
 * running from each column to the next, summed over rows.
 */
function ingestStages(
  rows: Record<string, unknown>[],
  pathKeys: string[],
  valueKey: string,
  groupKey: string | undefined,
): Pick<GraphNet, "nodes" | "edges"> {
  const order: string[] = [];
  const label = new Map<string, { stage: number; name: string }>();
  const parents = new Map<string, string[]>();
  const group = new Map<string, string>();
  const edges = new Map<string, GraphEdge>();
  const idOf = (stage: number, name: string) => `${stage}${GRAPH_SEP}${name}`;
  for (const row of rows) {
    const v = toNumber(row[valueKey]);
    const path = pathKeys.map((k) => toText(row[k]) || "(none)");
    const ids = path.map((name, stage) => {
      const id = idOf(stage, name);
      if (!label.has(id)) {
        label.set(id, { stage, name });
        parents.set(id, []);
        order.push(id);
      }
      return id;
    });
    const last = ids.at(-1) as string;
    if (groupKey && !group.has(last)) {
      const g = toText(row[groupKey]);
      if (g) group.set(last, g);
    }
    for (let i = 0; i + 1 < ids.length; i++) {
      const s = ids[i] as string;
      const t = ids[i + 1] as string;
      const ps = parents.get(t) as string[];
      if (!ps.includes(s)) ps.push(s);
      const id = graphEdgeId(s, t);
      const edge = edges.get(id) ?? {
        id,
        source: s,
        target: t,
        value: 0,
        row: {
          [pathKeys[i] as string]: path[i],
          [pathKeys[i + 1] as string]: path[i + 1],
        },
      };
      edge.value = (edge.value ?? 0) + v;
      edges.set(id, edge);
    }
  }
  return {
    nodes: order.map((id) => {
      const { stage, name } = label.get(id) as { stage: number; name: string };
      const g = group.get(id);
      const row: Record<string, unknown> = {
        [pathKeys[stage] as string]: name,
        node: name,
      };
      if (groupKey && g !== undefined) {
        row[groupKey] = g;
        row.group = g;
      }
      return {
        id,
        name,
        parents: parents.get(id) as string[],
        row,
        ...(g !== undefined ? { group: g } : {}),
      };
    }),
    edges: [...edges.values()].map((e) => ({
      ...e,
      row: { ...e.row, [valueKey]: e.value },
    })),
  };
}

/**
 * Why the flows cannot be a Sankey: a node on a cycle, and the cycle, found
 * by peeling off nodes with nothing left flowing in (Kahn's) and walking what
 * remains until it comes back on itself. Nothing when there is none.
 */
function findCycle(net: GraphNet): string | undefined {
  const name = (id: string) => net.nodes.find((n) => n.id === id)?.name ?? id;
  const self = net.edges.find((e) => e.source === e.target);
  if (self) {
    return `"${name(self.source)}" flows into itself; a Sankey's flows run one way, so draw it as a graph with layout "dag"`;
  }
  const into = new Map(net.nodes.map((n) => [n.id, 0]));
  const next = new Map<string, string[]>();
  for (const e of net.edges) {
    into.set(e.target, (into.get(e.target) ?? 0) + 1);
    next.set(e.source, [...(next.get(e.source) ?? []), e.target]);
  }
  const free = [...into].filter(([, n]) => n === 0).map(([id]) => id);
  for (let i = 0; i < free.length; i++) {
    for (const t of next.get(free[i] as string) ?? []) {
      const n = (into.get(t) ?? 0) - 1;
      into.set(t, n);
      if (n === 0) free.push(t);
    }
  }
  const left = new Set([...into].filter(([, n]) => n > 0).map(([id]) => id));
  if (left.size === 0) return undefined;
  // Every node left has a flow in from another left: walk those back.
  const prev = new Map<string, string>();
  for (const e of net.edges) {
    if (left.has(e.source) && left.has(e.target) && !prev.has(e.target)) {
      prev.set(e.target, e.source);
    }
  }
  const walked: string[] = [];
  let at = [...left][0] as string;
  while (!walked.includes(at)) {
    walked.push(at);
    at = prev.get(at) as string;
  }
  const loop = walked.slice(walked.indexOf(at)).reverse();
  const path = [...loop, loop[0] as string].map(name).join(" → ");
  return `"${name(at)}" is on a cycle (${path}); a Sankey's flows run one way, so draw it as a graph with layout "dag"`;
}

/** Why these rows cannot be drawn as a Sankey, naming what is wrong. */
export function sankeyProblem(panel: Panel, data: PanelData): string | undefined {
  return sankeyNet(panel, data).problem;
}

/** What the panel says when it left rows out: how many, and why. */
export function sankeyNotice(panel: Panel, data: PanelData): PanelNotice | undefined {
  const net = sankeyNet(panel, data);
  if (net.problem || net.dropped === 0) return undefined;
  const rows = net.dropped === 1 ? "1 row has" : `${net.dropped} rows have`;
  return {
    label: "Rows left out",
    detail: `${rows} no positive value in "${net.valueKey}", and a Sankey draws only flows with a volume.`,
  };
}

/** A direction change remounts; a data update merges (invariant 11). */
export function sankeyShape(panel: Panel): string {
  return readOptions(SankeyOptions, panel.options).orient ?? "LR";
}

/** What a click on the item with this id is: a node's datum, or a flow's. */
export function sankeyClickDatum(
  panel: Panel,
  data: PanelData,
  id: string,
): Datum | null {
  const net = sankeyNet(panel, data);
  if (net.problem) return null;
  const node = net.nodes.find((n) => n.id === id);
  if (node) return graphDatum(node);
  const edge = net.edges.find((e) => e.id === id);
  return edge ? graphEdgeDatum(net, edge) : null;
}

/**
 * The flows as the screen-reader table (#77): one row per flow, its ends and
 * volume, and what leaves its source and enters its target in all, so every
 * node's totals in and out are read somewhere. Each row offers the flow's
 * links.
 */
export function sankeyTable(
  panel: Panel,
  data: PanelData,
  _display?: TimeDisplay,
): ChartRows {
  const net = sankeyNet(panel, data);
  const o = readOptions(SankeyOptions, panel.options);
  const display = numberDisplay(o);
  const text = (v: number) => formatValue(v, panel.format, display);
  const byId = new Map(net.nodes.map((n) => [n.id, n]));
  const nameOf = (id: string) => byId.get(id)?.name ?? id;
  const edges = net.problem ? [] : net.edges;
  const shown = edges.slice(0, CHART_TABLE_ROWS_MAX);
  const count =
    shown.length === edges.length
      ? `${edges.length} ${edges.length === 1 ? "flow" : "flows"}`
      : `the first ${shown.length} of ${edges.length} flows`;
  const [from, to] =
    net.shape === "edges" && net.sourceKey && net.targetKey
      ? [net.sourceKey, net.targetKey]
      : ["from", "to"];
  return {
    caption: `Flows of ${panel.title}: ${count}.`,
    columns: [from, to, net.valueKey ?? "value", `${from} total out`, `${to} total in`],
    rows: shown.map((e) => [
      nameOf(e.source),
      nameOf(e.target),
      text(e.value ?? 0),
      text(net.totals.get(e.source)?.out ?? 0),
      text(net.totals.get(e.target)?.in ?? 0),
    ]),
    datums: shown.map((e) => graphEdgeDatum(net, e)),
    labels: shown.map((e) => `${nameOf(e.source)} → ${nameOf(e.target)}`),
  };
}

/** A node's color: its group's, else its own place in the palette. */
function colorer(net: GraphNet, theme: ChartTheme) {
  if (net.groups.length > 0) {
    return (node: GraphVertex) =>
      seriesColor(
        theme,
        node.group === undefined ? net.groups.length : net.groups.indexOf(node.group),
      );
  }
  const index = new Map(net.nodes.map((n, i) => [n.id, i]));
  return (node: GraphVertex) => seriesColor(theme, index.get(node.id) ?? 0);
}

/** Nodes or flows past a cap, said in the corner; always set, so a count that drops clears. */
function overflowTitle(theme: ChartTheme, net: GraphNet) {
  const parts = [
    ...(net.overflow > 0
      ? [`+${net.overflow} more ${net.overflow === 1 ? "node" : "nodes"}`]
      : []),
    ...(net.edgeOverflow > 0
      ? [`+${net.edgeOverflow} more ${net.edgeOverflow === 1 ? "flow" : "flows"}`]
      : []),
  ];
  return {
    text: parts.length > 0 ? `${parts.join(", ")} not shown` : "",
    right: 0,
    bottom: 0,
    textStyle: { color: theme.text, fontSize: 11, fontWeight: "normal" as const },
  };
}

/**
 * A weighted flow: an ECharts `sankey`, its stages left to right or top to
 * bottom, justified so the last stage sits at the far edge, each flow as wide
 * as its volume and shaded from its source's color to its target's.
 */
export const sankeyChart: ChartOptionBuilder = normalized((panel, data, { theme }) => {
  const net = sankeyNet(panel, data);
  const o = readOptions(SankeyOptions, panel.options);
  const display = numberDisplay(o);
  const text = (v: number) => formatValue(v, panel.format, display);
  const vertical = o.orient === "TB";
  const colorOf = colorer(net, theme);
  const byId = new Map(net.nodes.map((n) => [n.id, n]));
  const nameOf = (id: string) => byId.get(id)?.name ?? id;
  // A cycle is refused before this is drawn, and ECharts throws on one, so
  // a refused net draws nothing at all.
  const ok = net.problem === undefined;
  // The last stage's labels sit beside it, outside the flows: room for the
  // longest of them, by its length, up to 200 pixels.
  const sources = new Set(net.edges.map((e) => e.source));
  const longest = Math.max(
    0,
    ...net.nodes
      .filter((n) => !sources.has(n.id))
      .map(
        (n) => (n.value === undefined ? n.name : `${n.name}  ${text(n.value)}`).length,
      ),
  );
  const labelWidth = Math.min(200, 20 + longest * 7);
  const nodes = (ok ? net.nodes : []).map((node) => {
    const color = colorOf(node);
    return {
      id: node.id,
      name: node.name,
      text: node.value === undefined ? node.name : `${node.name}  ${text(node.value)}`,
      group: node.group,
      itemStyle: { color, borderColor: theme.background, borderWidth: 1 },
      label: { backgroundColor: color, color: inkOn(color) },
    };
  });
  const links = (ok ? net.edges : []).map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    value: e.value ?? 0,
  }));
  return {
    backgroundColor: "transparent",
    tooltip: {
      trigger: "item",
      borderRadius: 0,
      formatter: (p: unknown) => {
        const {
          dataType,
          data: item,
          value,
        } = p as {
          dataType?: string;
          value?: number;
          data?: { name?: string; source?: string; target?: string; group?: string };
        };
        if (!item) return "";
        const lines =
          dataType === "edge"
            ? [`${nameOf(item.source ?? "")} → ${nameOf(item.target ?? "")}`]
            : [item.name ?? ""];
        if (typeof value === "number") lines.push(text(value));
        if (dataType !== "edge" && item.group) lines.push(item.group);
        return lines.map(escapeHtml).join("<br/>");
      },
    },
    title: overflowTitle(theme, net),
    series: [
      {
        type: "sankey",
        orient: vertical ? "vertical" : "horizontal",
        nodeAlign: "justify",
        // Room for the labels beside the last stage: right of it, or below.
        ...(vertical
          ? { left: 16, right: 16, top: 12, bottom: 36 }
          : { left: 8, right: labelWidth, top: 12, bottom: 12 }),
        draggable: false,
        layoutIterations: 32,
        // Small nodes side by side (top to bottom, a thin last stage) would
        // write over each other: the overlapped label waits for the pointer.
        labelLayout: { hideOverlap: true },
        data: nodes,
        links,
        lineStyle: { color: "gradient", opacity: 0.35, curveness: 0.5 },
        label: {
          show: true,
          position: vertical ? "bottom" : "right",
          fontSize: 11,
          padding: [2, 4],
          borderRadius: 2,
          distance: 4,
          formatter: (p: unknown) => (p as { data?: { text?: string } }).data?.text ?? "",
        },
        emphasis: { focus: "adjacency", lineStyle: { opacity: 0.6 } },
      },
    ],
  } as EChartsOption;
});
