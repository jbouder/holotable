import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ctrlZoomSeries,
  roamKind,
  treeClickPart,
  withTreeState,
} from "@/components/charts/EChart";
import {
  GRAPH_EDGES_MAX,
  GRAPH_NODES_MAX,
  GRAPH_ROOT_ID,
  FORCE_LABELS_MAX,
  forceSpacing,
  graphChart,
  graphClickDatum,
  graphEdgeId,
  graphNet,
  graphNodes,
  graphNotice,
  graphShape,
  graphTable,
  graphTree,
  graphView,
} from "@/components/charts/graph";
import type { PanelData } from "@/components/charts/options";
import { GRAPH_BLOCK_MAX_WIDTH } from "@/components/charts/graph-blocks";
import { DEFAULT_CHART_THEME, inkOn, soften } from "@/lib/color/chart-theme";
import {
  AA_TEXT,
  contrastRatio,
  hexToRgb,
  parseThemeDecls,
  parseThemeTokens,
  resolveBlock,
} from "@/lib/color/contrast";
import { graphLayout } from "@/lib/graph/layout";
import { tidyTree } from "@/lib/graph/tidy-tree";
import { DEMO_LINKS } from "../scripts/lib/demo-files";
import { GRAPH_SYMBOLS, ICON_PATHS, isIcon } from "@/lib/graph/symbols";
import { Panel } from "@/lib/ir";
import { LOCAL_TIME_DISPLAY } from "@/lib/time-display";

/*
 * The graph kind (#623): edge rows or path columns as one tree, refused with
 * the node named when they are not a tree, drawn with labels that read on
 * their node's color and symbols only from the allowlist. The `dag` layout
 * (#624): the same rows as a layered directed graph, placed by a layout that
 * is deterministic, places every node and runs every edge with the flow but
 * the cycle's it marks; a tree that is not one falls back to it. The `force`
 * layout (#625): the same net as a cloud that settles once and keeps its
 * place across polls.
 */

const LAYOUT = { x: 0, y: 0, w: 12, h: 4 };
const CTX = { display: LOCAL_TIME_DISPLAY, theme: DEFAULT_CHART_THEME };

function graph(options: Record<string, unknown> = {}): Panel {
  return Panel.parse({
    id: "g",
    title: "Service map",
    viz: "graph",
    query: { sourceId: "s", sql: "SELECT 1" },
    options,
    layout: LAYOUT,
  });
}

const accepts = (options: Record<string, unknown>) =>
  Panel.safeParse({
    id: "g",
    title: "Service map",
    viz: "graph",
    query: { sourceId: "s", sql: "SELECT 1" },
    options,
    layout: LAYOUT,
  }).success;

const CALLS: PanelData = {
  columns: ["period", "caller", "callee", "tier", "requests"],
  rows: [
    { period: "t1", caller: "gateway", callee: "auth", tier: "service", requests: 10 },
    { period: "t1", caller: "gateway", callee: "orders", tier: "service", requests: 20 },
    { period: "t1", caller: "orders", callee: "orders-db", tier: "store", requests: 30 },
    { period: "t2", caller: "gateway", callee: "orders", tier: "service", requests: 5 },
  ],
};
const EDGES = {
  source: "caller",
  target: "callee",
  value: "requests",
  group: "tier",
};

test("edge rows are one tree: a repeated edge sums, a root shows what leaves it", () => {
  const tree = graphTree(graph(EDGES), CALLS);
  assert.equal(tree.problem, undefined);
  assert.equal(tree.shape, "edges");
  const [root] = tree.roots;
  assert.equal(root?.name, "gateway");
  assert.equal(root?.value, 35);
  assert.deepEqual(
    root?.children.map((c) => [c.name, c.value, c.group]),
    [
      ["auth", 10, "service"],
      ["orders", 25, "service"],
    ],
  );
  assert.deepEqual(tree.groups, ["service", "store"]);
  const db = graphNodes(tree).find((n) => n.name === "orders-db");
  assert.deepEqual(db?.row, {
    period: "t1",
    caller: "orders",
    callee: "orders-db",
    requests: 30,
    tier: "store",
    node: "orders-db",
    parent: "orders",
    group: "store",
    value: 30,
  });
});

test("without options, the first two text columns are the parent and the child", () => {
  const tree = graphTree(graph(), {
    columns: ["parent", "child", "n"],
    rows: [
      { parent: "a", child: "b", n: 1 },
      { parent: "b", child: "c", n: 2 },
    ],
  });
  assert.equal(tree.sourceKey, "parent");
  assert.equal(tree.targetKey, "child");
  assert.deepEqual(
    graphNodes(tree).map((n) => n.name),
    ["a", "b", "c"],
  );
});

test("path columns are a tree as the treemap reads them, parents the sum of their leaves", () => {
  const tree = graphTree(graph({ path: ["schema", "table", "column"], value: "bytes" }), {
    columns: ["schema", "table", "column", "bytes"],
    rows: [
      { schema: "metrics", table: "http", column: "ts", bytes: 8 },
      { schema: "metrics", table: "http", column: "route", bytes: 4 },
      { schema: "metrics", table: "logs", column: "ts", bytes: 8 },
    ],
  });
  assert.equal(tree.shape, "path");
  const [root] = tree.roots;
  assert.equal(root?.name, "metrics");
  assert.equal(root?.value, 20);
  assert.deepEqual(
    root?.children.map((c) => [c.name, c.value, c.children.length]),
    [
      ["http", 12, 2],
      ["logs", 8, 1],
    ],
  );
  // Two columns named "ts" are two nodes: a node is its path.
  const ts = graphNodes(tree).filter((n) => n.name === "ts");
  assert.equal(ts.length, 2);
  assert.deepEqual(ts[0]?.row, {
    schema: "metrics",
    table: "http",
    column: "ts",
    bytes: 8,
    node: "ts",
    parent: "http",
    value: 8,
  });
});

test("a node with two parents is no tree, naming it", () => {
  const tree = graphTree(graph(EDGES), {
    columns: CALLS.columns,
    rows: [
      ...CALLS.rows,
      { caller: "auth", callee: "orders-db", tier: "store", requests: 1 },
    ],
  });
  assert.equal(
    tree.problem,
    '"orders-db" has two parents ("orders" and "auth"); a tree needs one',
  );
  assert.deepEqual(tree.roots, []);
});

test("a cycle is no tree, naming a node on it, and nor is a node pointing at itself", () => {
  const cycle = graphTree(graph(EDGES), {
    columns: ["caller", "callee"],
    rows: [
      { caller: "root", callee: "x" },
      { caller: "a", callee: "b" },
      { caller: "b", callee: "c" },
      { caller: "c", callee: "a" },
    ],
  });
  assert.match(cycle.problem ?? "", /^"[abc]" is on a cycle; a tree has none$/);
  const self = graphTree(graph(EDGES), {
    columns: ["caller", "callee"],
    rows: [{ caller: "a", callee: "a" }],
  });
  assert.equal(self.problem, '"a" points at itself; a tree has no cycles');
});

test("past the cap, the deepest nodes are left out and counted", () => {
  const rows = Array.from({ length: GRAPH_NODES_MAX + 10 }, (_, i) => ({
    caller: "hub",
    callee: `n${i}`,
  }));
  const tree = graphTree(graph(), { columns: ["caller", "callee"], rows });
  assert.equal(graphNodes(tree).length, GRAPH_NODES_MAX);
  assert.equal(tree.overflow, 11);
  const option = graphChart(graph(), { columns: ["caller", "callee"], rows }, CTX);
  assert.equal((option.title as { text: string }).text, "+11 more nodes not shown");
});

test("rows with no tree in them draw one invisible node, since ECharts' tree throws on none", () => {
  const option = graphChart(graph(), { columns: ["n"], rows: [{ n: 1 }] }, CTX);
  const data = (option.series as { data: { id: string; symbol: string }[] }[])[0]?.data;
  assert.deepEqual(
    data?.map((d) => [d.id, d.symbol]),
    [[GRAPH_ROOT_ID, "none"]],
  );
});

test("odd rows draw an empty or partial tree rather than throwing", () => {
  assert.deepEqual(graphTree(graph(), { columns: [], rows: [] }).roots, []);
  assert.deepEqual(graphTree(graph(), { columns: ["n"], rows: [{ n: 1 }] }).roots, []);
  assert.doesNotThrow(() =>
    graphChart(
      graph(EDGES),
      { columns: ["caller", "callee"], rows: [{ caller: {}, callee: Symbol("x") }] },
      CTX,
    ),
  );
});

test("each label reads on its node's color, in both schemes (AA)", () => {
  const option = graphChart(graph(EDGES), CALLS, CTX);
  const series = (option.series as { type: string; data: Item[] }[])[0];
  assert.equal(series?.type, "tree");
  interface Item {
    itemStyle: { color: string };
    label: { color: string; backgroundColor: string };
    children?: Item[];
  }
  const walk = (items: Item[]): Item[] =>
    items.flatMap((i) => [i, ...walk(i.children ?? [])]);
  for (const item of walk(series?.data ?? [])) {
    assert.equal(item.label.backgroundColor, item.itemStyle.color);
    assert.equal(item.label.color, inkOn(item.itemStyle.color));
  }
  // The colors a node takes are the series colors: every one, in every theme
  // and scheme, holds AA against the ink chosen for it.
  const themes = parseThemeTokens(readFileSync("src/app/globals.css", "utf8"));
  for (const [scheme, tokens] of Object.entries(themes)) {
    for (let i = 1; i <= 8; i++) {
      const rgb = tokens[`chart-${i}`];
      assert.ok(rgb, `${scheme}: --chart-${i}`);
      const hex = `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
      const ratio = contrastRatio(hexToRgb(inkOn(hex)), rgb);
      assert.ok(ratio >= AA_TEXT, `${scheme} chart-${i}: ${ratio.toFixed(2)}:1`);
    }
  }
});

test("several roots hang under one named for the panel, which is no datum", () => {
  const option = graphChart(
    graph(),
    {
      columns: ["caller", "callee"],
      rows: [
        { caller: "a", callee: "b" },
        { caller: "c", callee: "d" },
      ],
    },
    CTX,
  );
  const [root] =
    (option.series as { data: { id: string; children: unknown[] }[] }[])[0]?.data ?? [];
  assert.equal(root?.id, GRAPH_ROOT_ID);
  assert.equal(root?.children.length, 2);
});

test("symbols come only from the allowlist, and every icon is a path", () => {
  for (const symbol of GRAPH_SYMBOLS) assert.equal(accepts({ symbol }), true, symbol);
  assert.equal(accepts({ symbol: "hexagon" }), false);
  assert.equal(accepts({ symbol: "path://M0 0L1 1z" }), false);
  assert.equal(accepts({ symbol: "image://https://example.com/x.png" }), false);
  assert.equal(
    accepts({ symbols: { store: "image://https://example.com/x.png" } }),
    false,
  );
  assert.equal(accepts({ symbolSize: 2 }), false);
  assert.equal(accepts({ symbolSize: 100 }), false);
  for (const name of Object.keys(ICON_PATHS) as (keyof typeof ICON_PATHS)[]) {
    assert.ok(isIcon(name));
    assert.match(ICON_PATHS[name], /^M[\d.\s\-MLHVCSQTAZmlhvcsqtaz,]+$/, name);
  }
});

test("a group's symbol beats the default, and an icon is drawn large enough to read", () => {
  const option = graphChart(
    graph({ ...EDGES, symbol: "loadBalancer", symbols: { store: "database" } }),
    CALLS,
    CTX,
  );
  interface Item {
    name: string;
    symbol: string;
    symbolSize: number;
    children?: Item[];
  }
  const walk = (items: Item[]): Item[] =>
    items.flatMap((i) => [i, ...walk(i.children ?? [])]);
  const items = walk((option.series as { data: Item[] }[])[0]?.data ?? []);
  const by = (name: string) => items.find((i) => i.name === name);
  assert.equal(by("orders-db")?.symbol, `path://${ICON_PATHS.database}`);
  assert.equal(by("auth")?.symbol, `path://${ICON_PATHS.loadBalancer}`);
  assert.equal(by("auth")?.symbolSize, 24);
  const plain = walk(
    (graphChart(graph(EDGES), CALLS, CTX).series as { data: Item[] }[])[0]?.data ?? [],
  );
  assert.equal(plain[0]?.symbol, "circle");
  assert.equal(plain[0]?.symbolSize, 10);
});

test("collapseDepth closes the levels below it; a layout change remounts, data merges", () => {
  const option = graphChart(graph({ ...EDGES, collapseDepth: 1 }), CALLS, CTX);
  const [root] = (option.series as { data: Record<string, unknown>[] }[])[0]?.data ?? [];
  assert.equal(root?.collapsed, undefined);
  const orders = ((root?.children ?? []) as Record<string, unknown>[]).find(
    (c) => c.name === "orders",
  );
  assert.equal(orders?.collapsed, true);
  assert.equal(graphShape(graph(EDGES)), graphShape(graph({ ...EDGES, value: "x" })));
  assert.notEqual(graphShape(graph()), graphShape(graph({ orient: "TB" })));
  assert.equal(accepts({ orient: "diagonal" }), false);
  assert.equal(accepts({ layout: "tree", orient: "radial" }), true);
});

test("the screen-reader table is one row per edge, each the child's datum", () => {
  const table = graphTable(graph(EDGES), CALLS);
  assert.deepEqual(table.columns, ["caller", "callee", "requests"]);
  assert.deepEqual(table.rows, [
    ["gateway", "auth", "10"],
    ["gateway", "orders", "25"],
    ["orders", "orders-db", "30"],
  ]);
  assert.equal(table.caption, "Edges of Service map: 3 edges.");
  assert.equal(table.datums[2]?.series, "orders-db");
  assert.deepEqual(table.labels, ["auth", "orders", "orders-db"]);
});

test("a node's symbol opens and closes its branch; its label is a datum (#373)", () => {
  const label = { type: "text" };
  assert.equal(treeClickPart({ seriesType: "tree", event: { target: label } }), "datum");
  // A label's background and spans are its children.
  assert.equal(
    treeClickPart({
      seriesType: "tree",
      event: { target: { type: "rect", parent: label } },
    }),
    "datum",
  );
  assert.equal(
    treeClickPart({ seriesType: "tree", event: { target: { type: "path" } } }),
    "toggle",
  );
  assert.equal(treeClickPart({ seriesType: "pie", event: { target: label } }), null);
  // What a reader toggled survives the next poll's merged option.
  const option = graphChart(graph(EDGES), CALLS, CTX);
  const kept = withTreeState(option, new Map([["orders", true]]));
  const [root] = (kept.series as { data: Record<string, unknown>[] }[])[0]?.data ?? [];
  const orders = ((root?.children ?? []) as Record<string, unknown>[]).find(
    (c) => c.name === "orders",
  );
  assert.equal(orders?.collapsed, true);
  assert.equal(withTreeState(option, new Map()), option);
});

/** A dependency graph: a shared child, a skipped layer, and a cycle. */
const DEPS: PanelData = {
  columns: ["from", "to", "calls"],
  rows: [
    { from: "web", to: "api", calls: 10 },
    { from: "web", to: "auth", calls: 4 },
    { from: "api", to: "auth", calls: 6 },
    { from: "api", to: "db", calls: 20 },
    { from: "auth", to: "db", calls: 2 },
    { from: "web", to: "db", calls: 1 },
    { from: "db", to: "replica", calls: 3 },
    { from: "replica", to: "api", calls: 1 },
    { from: "api", to: "db", calls: 5 },
  ],
};
const DAG = { layout: "dag", source: "from", target: "to", value: "calls" };

test("the layout places every node, runs every edge with the flow but the reversed, and is deterministic", () => {
  const ids = ["web", "api", "auth", "db", "replica", "lonely"];
  const edges = DEPS.rows.map((r) => ({
    source: r.from as string,
    target: r.to as string,
  }));
  for (const direction of ["LR", "TB"] as const) {
    const layout = graphLayout(ids, edges, direction);
    assert.deepEqual(
      layout.nodes.map((n) => n.id),
      ids,
      "every node, in the order given",
    );
    for (const n of layout.nodes) {
      assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), n.id);
      // The layer runs along the direction.
      assert.equal(direction === "LR" ? n.x : n.y, n.layer, n.id);
    }
    const layer = new Map(layout.nodes.map((n) => [n.id, n.layer]));
    // A repeated edge is one.
    assert.equal(layout.edges.length, 8);
    for (const e of layout.edges) {
      const [s, t] = [layer.get(e.source) as number, layer.get(e.target) as number];
      assert.ok(e.reversed ? s > t : s < t, `${e.source} → ${e.target}`);
    }
    // The cycle api → db → replica → api is broken at one edge, and only one.
    assert.equal(layout.reversed, 1);
    assert.deepEqual(
      layout.edges.filter((e) => e.reversed).map((e) => [e.source, e.target]),
      [["replica", "api"]],
    );
    // No two nodes share a place.
    const places = new Set(layout.nodes.map((n) => `${n.x},${n.y}`));
    assert.equal(places.size, ids.length);
    assert.deepEqual(graphLayout(ids, edges, direction), layout, "the same again");
  }
  // A cycle with nothing above it, a self-edge, an unknown end and no nodes.
  const ring = graphLayout(
    ["a", "b", "c"],
    [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
      { source: "c", target: "a" },
      { source: "a", target: "a" },
      { source: "a", target: "nowhere" },
    ],
  );
  assert.equal(ring.reversed, 1);
  assert.equal(ring.edges.length, 3);
  assert.deepEqual(graphLayout([], []), {
    nodes: [],
    edges: [],
    reversed: 0,
    layers: 0,
    crossings: 0,
  });
});

test("the layout untangles what it can: a crossing the input order makes is undone", () => {
  // a's child listed second and b's first: drawn in input order, they cross.
  const layout = graphLayout(
    ["a", "b", "y", "x"],
    [
      { source: "a", target: "x" },
      { source: "b", target: "y" },
    ],
  );
  assert.equal(layout.crossings, 0);
  const at = new Map(layout.nodes.map((n) => [n.id, n.order]));
  assert.equal(at.get("a") === 0, at.get("x") === 0);
});

test("a directed graph's rows are nodes with every parent and edges once, their values summed", () => {
  const net = graphNet(graph(DAG), DEPS);
  assert.deepEqual(
    net.nodes.map((n) => [n.id, n.parents, n.value]),
    [
      ["web", [], 15],
      ["api", ["web", "replica"], 11],
      ["auth", ["web", "api"], 10],
      ["db", ["api", "auth", "web"], 28],
      ["replica", ["db"], 3],
    ],
  );
  assert.equal(net.edges.length, 8);
  assert.equal(net.edges.find((e) => e.id === graphEdgeId("api", "db"))?.value, 25);
  // A node's datum is a tree node's: its first parent is the `parent`, so a
  // link that reads `node` works on either layout.
  assert.deepEqual(net.nodes.find((n) => n.id === "db")?.row, {
    from: "api",
    to: "db",
    calls: 28,
    node: "db",
    parent: "api",
    value: 28,
  });
});

test("a tree that is not one falls back to the directed graph, with a notice naming why", () => {
  const twoParents = {
    columns: CALLS.columns,
    rows: [
      ...CALLS.rows,
      { caller: "auth", callee: "orders-db", tier: "store", requests: 1 },
    ],
  };
  const view = graphView(graph(EDGES), twoParents);
  assert.equal(view.layout, "dag");
  assert.deepEqual(graphNotice(graph(EDGES), twoParents), {
    label: "Not a tree",
    detail:
      '"orders-db" has two parents ("orders" and "auth"); a tree needs one, so it is drawn as a directed graph. Set the layout to "dag" to draw it that way on purpose.',
  });
  const option = graphChart(graph(EDGES), twoParents, CTX);
  assert.equal((option.series as { type: string }[])[0]?.type, "graph");
  // A cycle falls back too; a tree draws as one and says nothing; a dag
  // asked for says nothing either.
  const cycle = {
    columns: ["caller", "callee"],
    rows: [
      { caller: "a", callee: "b" },
      { caller: "b", callee: "a" },
    ],
  };
  assert.match(graphNotice(graph(), cycle)?.detail ?? "", /is on a cycle/);
  assert.equal(graphNotice(graph(EDGES), CALLS), undefined);
  assert.equal(graphView(graph(EDGES), CALLS).layout, "tree");
  assert.equal(graphNotice(graph({ ...EDGES, layout: "dag" }), twoParents), undefined);
  // A tree's orientation carries over as the nearer direction.
  const tb = graphView(graph({ ...EDGES, orient: "BT" }), twoParents);
  assert.equal(tb.layout === "dag" && tb.direction, "TB");
});

test("a directed graph draws arrows, the cycle's edge dashed, widths by value, and labels that read", () => {
  const option = graphChart(graph({ ...DAG, edgeLabels: true }), DEPS, CTX);
  const series = (option.series as Record<string, unknown>[])[0] as {
    type: string;
    layout: string;
    edgeSymbol: string[];
    edgeLabel: { show: boolean };
    coordinateSystem: string;
    data: {
      id: string;
      value: number[];
      itemStyle: { color: string };
      label: { color: string; backgroundColor: string };
    }[];
    links: {
      id: string;
      source: string;
      target: string;
      reversed: boolean;
      lineStyle: { width: number; type?: string; curveness: number };
    }[];
  };
  assert.equal(series.type, "graph");
  assert.equal(series.layout, "none");
  assert.deepEqual(series.edgeSymbol, ["none", "arrow"]);
  assert.equal(series.edgeLabel.show, true);
  assert.equal(series.data.length, 5);
  // On hidden axes, so a symbol keeps its shape whatever the panel's.
  assert.equal(series.coordinateSystem, "cartesian2d");
  for (const node of series.data) {
    assert.ok(node.value.length === 2 && node.value.every(Number.isFinite));
    assert.equal(node.label.backgroundColor, node.itemStyle.color);
    assert.equal(node.label.color, inkOn(node.itemStyle.color));
  }
  const back = series.links.filter((l) => l.reversed);
  assert.deepEqual(
    back.map((l) => [l.source, l.target]),
    [["replica", "api"]],
  );
  assert.equal(back[0]?.lineStyle.type, "dashed");
  const widths = new Map(series.links.map((l) => [l.id, l.lineStyle.width]));
  assert.equal(widths.get(graphEdgeId("api", "db")), 6, "the busiest edge is the widest");
  assert.ok((widths.get(graphEdgeId("web", "db")) as number) < 2);
  // Straight on request.
  const straight = graphChart(graph({ ...DAG, curve: false }), DEPS, CTX);
  const links =
    (
      straight.series as {
        links: { reversed: boolean; lineStyle: { curveness: number } }[];
      }[]
    )[0]?.links ?? [];
  assert.ok(links.filter((l) => !l.reversed).every((l) => l.lineStyle.curveness === 0));
});

test("a click on a directed graph's edge is a datum with its source, target and value", () => {
  const panel = graph(DAG);
  assert.deepEqual(graphClickDatum(panel, DEPS, graphEdgeId("api", "db")), {
    row: { from: "api", to: "db", calls: 25, source: "api", target: "db", value: 25 },
    series: "api → db",
  });
  // The cycle's reversed edge keeps its real ends.
  assert.deepEqual(graphClickDatum(panel, DEPS, graphEdgeId("replica", "api"))?.row, {
    from: "replica",
    to: "api",
    calls: 1,
    source: "replica",
    target: "api",
    value: 1,
  });
  assert.equal(graphClickDatum(panel, DEPS, "db")?.row.node, "db");
  assert.equal(graphClickDatum(panel, DEPS, "nothing"), null);
});

test("a directed graph's table is its edges, with each end's layer and the back edge said", () => {
  const table = graphTable(graph(DAG), DEPS);
  assert.deepEqual(table.columns, ["from", "to", "calls", "layers"]);
  assert.equal(table.rows.length, 8);
  assert.match(table.caption, /^Edges of Service map: 8 edges, in \d layers\.$/);
  const back = table.rows.find((r) => r[0] === "replica");
  assert.match(back?.[3] ?? "", /^\d → \d, back edge$/);
  assert.deepEqual(
    table.rows.find((r) => r[0] === "web" && r[1] === "api")?.slice(0, 3),
    ["web", "api", "10"],
  );
  // A row offers the links of the node it reaches, as the tree's does.
  assert.equal(table.datums[0]?.series, "api");
});

test("a self-edge is listed, not drawn, and its node says it; past the caps, edges are counted", () => {
  const data = {
    columns: ["from", "to"],
    rows: [
      { from: "a", to: "a" },
      { from: "a", to: "b" },
    ],
  };
  const option = graphChart(graph({ layout: "dag" }), data, CTX);
  const series = (
    option.series as { data: { id: string; text: string }[]; links: unknown[] }[]
  )[0];
  assert.equal(series?.links.length, 1);
  assert.equal(series?.data.find((n) => n.id === "a")?.text, "a ↻");
  assert.match(
    graphTable(graph({ layout: "dag" }), data).rows[0]?.[2] ?? "",
    /to itself/,
  );
  // Nodes past the cap and edges past theirs are counted in the corner.
  const rows = Array.from({ length: GRAPH_EDGES_MAX + 5 }, (_, i) => ({
    from: `n${i % 40}`,
    to: `n${(i * 7 + 1) % 40}x${Math.floor(i / 40)}`,
  }));
  const big = graphNet(graph({ layout: "dag" }), { columns: ["from", "to"], rows });
  assert.equal(big.nodes.length, GRAPH_NODES_MAX);
  assert.ok(big.overflow > 0 && big.edgeOverflow > 0);
  assert.ok(big.edges.length <= GRAPH_EDGES_MAX);
  const title = (
    graphChart(graph({ layout: "dag" }), { columns: ["from", "to"], rows }, CTX)
      .title as { text: string }
  ).text;
  assert.match(title, /^\+\d+ more nodes, \+\d+ more edges not shown$/);
  // No rows draw nothing, and do not throw.
  assert.doesNotThrow(() =>
    graphChart(graph({ layout: "dag" }), { columns: [], rows: [] }, CTX),
  );
});

test("a layout or direction change remounts the chart", () => {
  assert.notEqual(graphShape(graph()), graphShape(graph({ layout: "dag" })));
  assert.notEqual(
    graphShape(graph({ layout: "dag" })),
    graphShape(graph({ layout: "dag", direction: "TB" })),
  );
  assert.equal(
    accepts({ layout: "dag", direction: "TB", edgeLabels: true, curve: false }),
    true,
  );
  assert.equal(accepts({ direction: "RL" }), false);
  assert.notEqual(
    graphShape(graph({ layout: "dag" })),
    graphShape(graph({ layout: "force" })),
  );
  assert.equal(accepts({ layout: "force" }), true);
  assert.equal(accepts({ layout: "sankey" }), false);
});

const FORCE = { layout: "force", source: "from", target: "to", value: "calls" };

interface ForceSeries {
  type: string;
  layout: string;
  roam: unknown;
  draggable: boolean;
  edgeSymbol: string[];
  force: {
    layoutAnimation: boolean;
    initLayout: string;
    repulsion: number[];
    edgeLength: number;
  };
  label: { show: boolean };
  emphasis: { label: { show: boolean } };
  data: (Record<string, unknown> & {
    id: string;
    symbolSize: number;
    itemStyle: { color: string };
    label: { color: string; backgroundColor: string };
  })[];
  links: { id: string; source: string; target: string }[];
}

const forceSeries = (panel: Panel, data: PanelData) =>
  (graphChart(panel, data, CTX).series as ForceSeries[])[0] as ForceSeries;

test("a force graph settles at once and keeps its place on a poll, rather than jittering", () => {
  const series = forceSeries(graph(FORCE), DEPS);
  assert.equal(series.type, "graph");
  assert.equal(series.layout, "force");
  // Settled in one go, not animated in view; the same rows start the same way.
  assert.equal(series.force.layoutAnimation, false);
  assert.equal(series.force.initLayout, "circular");
  // ECharts keeps the positions it settled on by node id on the merged
  // series: so the ids are the rows' names, the same on every poll, and no
  // node is pinned or placed by the option, which would override them.
  const poll = forceSeries(graph(FORCE), {
    ...DEPS,
    rows: DEPS.rows.map((r) => ({ ...r, calls: (r.calls as number) + 1 })),
  });
  assert.deepEqual(
    poll.data.map((n) => n.id),
    series.data.map((n) => n.id),
  );
  assert.deepEqual(
    series.data.map((n) => n.id),
    ["web", "api", "auth", "db", "replica"],
  );
  for (const node of series.data) {
    for (const key of ["x", "y", "fixed", "value"]) {
      assert.ok(!(key in node), `${node.id} has no ${key}`);
    }
  }
  // A drag would restart the layout; the view pans, and a Ctrl-wheel zooms it.
  assert.equal(series.draggable, false);
  assert.equal(series.roam, "move");
  assert.deepEqual(ctrlZoomSeries(graphChart(graph(FORCE), DEPS, CTX)), [0]);
  assert.deepEqual(ctrlZoomSeries(graphChart(graph(DAG), DEPS, CTX)), []);
  // Undirected: no arrows, and nothing falls back or needs a notice.
  assert.deepEqual(series.edgeSymbol, ["none", "none"]);
  assert.equal(graphNotice(graph(FORCE), DEPS), undefined);
  for (const node of series.data) {
    assert.equal(node.label.backgroundColor, node.itemStyle.color);
    assert.equal(node.label.color, inkOn(node.itemStyle.color));
  }
});

test("a force graph spreads by its node count, thins its labels when dense, and sizes nodes by value", () => {
  // Fewer nodes push harder and sit further apart.
  const few = forceSpacing(5);
  const many = forceSpacing(300);
  assert.ok(few.repulsion > many.repulsion && few.edgeLength > many.edgeLength);
  assert.deepEqual(
    (({ repulsion, edgeLength }) => ({ repulsion, edgeLength }))(
      forceSeries(graph(FORCE), DEPS).force,
    ),
    // As ECharts' range, the same at both ends.
    { repulsion: [few.repulsion, few.repulsion], edgeLength: few.edgeLength },
  );
  // Past the cap, labels show on hover only.
  const ring = (n: number) => ({
    columns: ["from", "to"],
    rows: Array.from({ length: n }, (_, i) => ({ from: `n${i}`, to: `n${(i + 1) % n}` })),
  });
  const sparse = forceSeries(graph({ layout: "force" }), ring(FORCE_LABELS_MAX));
  assert.equal(sparse.label.show, true);
  const dense = forceSeries(graph({ layout: "force" }), ring(FORCE_LABELS_MAX + 1));
  assert.equal(dense.label.show, false);
  assert.equal(dense.emphasis.label.show, true);
  // By value: the largest twice the symbol's size, the smallest no less
  // than 60% of it; without a value, every node the symbol's size.
  const sized = forceSeries(graph({ ...FORCE, symbolSize: 20 }), DEPS);
  const sizes = sized.data.map((n) => n.symbolSize);
  assert.equal(Math.max(...sizes), 40);
  assert.ok(Math.min(...sizes) >= 12);
  const db = sized.data.find((n) => n.id === "db");
  assert.equal(db?.symbolSize, 40, "db takes the most calls");
  const plain = forceSeries(
    graph({ layout: "force", source: "from", target: "to" }),
    DEPS,
  );
  assert.ok(plain.data.every((n) => n.symbolSize === 10));
});

test("a force graph's nodes and edges are datums, and its table is its edges", () => {
  const panel = graph(FORCE);
  assert.deepEqual(graphClickDatum(panel, DEPS, graphEdgeId("api", "db")), {
    row: { from: "api", to: "db", calls: 25, source: "api", target: "db", value: 25 },
    series: "api → db",
  });
  assert.equal(graphClickDatum(panel, DEPS, "db")?.row.node, "db");
  const table = graphTable(panel, DEPS);
  assert.deepEqual(table.columns, ["from", "to", "calls"]);
  assert.equal(table.caption, "Edges of Service map: 8 edges.");
  assert.deepEqual(
    table.rows.find((r) => r[0] === "api" && r[1] === "db"),
    ["api", "db", "25"],
  );
  assert.equal(table.datums[0]?.series, "api");
});

/*
 * Blocks (#649): each node a box with its name inside, as a diagram is
 * drawn. Every box reads (AA) on its softened fill in every palette and
 * scheme; no two boxes overlap in any layout; a directed graph's edges meet
 * its boxes' borders; a panel too small for them draws markers and says so;
 * clicks and the table are a marker graph's.
 */

/** The demo's service map, as `scripts/lib/seed-data.ts` writes its edges. */
const SERVICE_MAP: PanelData = {
  columns: ["caller", "callee", "tier", "requests"],
  rows: [
    ["gateway", "api", "service", 1600],
    ["gateway", "web", "service", 1800],
    ["gateway", "worker", "service", 1700],
    ["api", "api-db", "database", 2500],
    ["web", "web-cache", "cache", 3400],
    ["worker", "worker-queue", "queue", 1300],
    ["api", "redis", "store", 1000],
    ["web", "redis", "store", 800],
  ].map(([caller, callee, tier, requests]) => ({ caller, callee, tier, requests })),
};
const BLOCKS = {
  ...EDGES,
  node: "block",
  compact: true,
  symbol: "loadBalancer",
  symbols: { service: "server", database: "database", store: "storage" },
};
/** About the drawn size of the demo's service map (w 7, h 4) and of a full-width panel. */
const DEFAULT_SIZE = { width: 780, height: 320 };
const WIDE = { width: 1380, height: 500 };

interface BlockItem {
  id: string;
  value?: number | number[];
  symbolSize: number | number[];
  label: { backgroundColor?: string; color?: string; width?: number; show?: boolean };
  children?: BlockItem[];
}
const seriesOf = (option: unknown) =>
  (option as { series: { type: string; data: BlockItem[]; links?: Link[] }[] })
    .series[0] as {
    type: string;
    data: BlockItem[];
    links?: Link[];
    label: { show: boolean };
    left?: number;
    top?: number;
  };
interface Link {
  id: string;
  source: string;
  target: string;
  from: string;
  to: string;
  reversed: boolean;
}
const isBox = (d: BlockItem) => Array.isArray(d.symbolSize);
const overlap = (
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
) => Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2;

test("block is an option of its own; marker, or none, draws exactly as before", () => {
  assert.ok(accepts({ node: "block" }));
  assert.ok(accepts({ node: "marker" }));
  assert.ok(!accepts({ node: "box" }));
  for (const layout of ["tree", "dag", "force"]) {
    for (const size of [undefined, DEFAULT_SIZE]) {
      const ctx = { ...CTX, size };
      const before = graphChart(graph({ ...EDGES, layout }), SERVICE_MAP, ctx);
      const marker = graphChart(
        graph({ ...EDGES, layout, node: "marker" }),
        SERVICE_MAP,
        ctx,
      );
      assert.deepEqual(
        JSON.parse(JSON.stringify(marker)),
        JSON.parse(JSON.stringify(before)),
        layout,
      );
    }
  }
  // A change of how nodes are drawn is a new chart.
  assert.notEqual(graphShape(graph(BLOCKS)), graphShape(graph(EDGES)));
});

test("every box's text clears AA on its softened fill, in every palette and scheme", () => {
  // The fill is the node's series color softened as a large area is (#647),
  // and the ink is whichever reads on it.
  const option = graphChart(graph({ ...BLOCKS, layout: "dag" }), SERVICE_MAP, CTX);
  const boxes = seriesOf(option).data.filter(isBox);
  assert.equal(boxes.length, 8);
  for (const b of boxes) {
    assert.ok(b.label.backgroundColor);
    assert.equal(b.label.color, inkOn(b.label.backgroundColor as string));
    assert.ok(
      DEFAULT_CHART_THEME.series.some(
        (c) => soften(DEFAULT_CHART_THEME, c) === b.label.backgroundColor,
      ),
    );
  }
  const hex = (rgb: readonly number[]) =>
    `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  const blocks = parseThemeDecls(readFileSync("src/app/globals.css", "utf8"));
  assert.ok(blocks.length >= 10);
  for (const { palette, scheme, decls } of blocks) {
    const { tokens } = resolveBlock(decls);
    const theme = {
      ...DEFAULT_CHART_THEME,
      background: hex(tokens.surface),
      soften: Number(decls["chart-soften"] ?? DEFAULT_CHART_THEME.soften),
    };
    for (let i = 1; i <= 8; i++) {
      const fill = soften(theme, hex(tokens[`chart-${i}`]));
      const ratio = contrastRatio(hexToRgb(inkOn(fill)), hexToRgb(fill));
      assert.ok(
        ratio >= AA_TEXT,
        `${palette} ${scheme} chart-${i}: ${ratio.toFixed(2)}:1`,
      );
    }
  }
});

test("a directed graph's boxes never overlap, and each edge runs from one box's border to the next's", () => {
  const network: PanelData = {
    columns: ["parent", "child", "tier", "bandwidth_gbps"],
    rows: DEMO_LINKS.map(([parent, child, tier, bandwidth_gbps]) => ({
      parent,
      child,
      tier,
      bandwidth_gbps,
    })),
  };
  const cases = [
    {
      panel: graph({ ...BLOCKS, layout: "dag", direction: "LR" }),
      data: SERVICE_MAP,
      size: DEFAULT_SIZE,
    },
    {
      panel: graph({
        layout: "dag",
        direction: "TB",
        node: "block",
        source: "parent",
        target: "child",
        value: "bandwidth_gbps",
        group: "tier",
        symbols: { router: "router", switch: "switch", server: "server" },
        unit: "Gbps",
      }),
      data: network,
      size: WIDE,
    },
  ];
  for (const { panel, data, size } of cases) {
    const option = graphChart(panel, data, { ...CTX, size }) as {
      grid: { width: number; height: number };
      xAxis: { min: number; max: number };
    };
    const series = seriesOf(option);
    const boxes = series.data.filter(isBox);
    // The demos draw blocks at their default sizes, not the fallback.
    assert.equal(boxes.length, data === SERVICE_MAP ? 8 : 11);
    assert.equal(graphNotice(panel, data, size), undefined);
    // A pixel a unit: the plot is the layout, and it fits the panel.
    assert.equal(option.xAxis.max - option.xAxis.min, option.grid.width);
    assert.ok(option.grid.width <= size.width && option.grid.height <= size.height);
    const at = new Map(
      boxes.map((b) => {
        const [x, y] = b.value as number[];
        const [w, h] = b.symbolSize as number[];
        return [b.id, { x: x as number, y: y as number, w: w as number, h: h as number }];
      }),
    );
    const list = [...at.values()];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        assert.ok(!overlap(list[i] as never, list[j] as never), `${i} and ${j} overlap`);
      }
    }
    const ports = new Map(
      series.data.filter((d) => !isBox(d)).map((d) => [d.id, d.value as number[]]),
    );
    const across = (panel.options as { direction?: string }).direction !== "TB";
    for (const link of series.links ?? []) {
      const from = at.get(link.from);
      const to = at.get(link.to);
      const start = ports.get(link.source);
      const end = ports.get(link.target);
      assert.ok(from && to && start && end, link.id);
      // On the border of its box, the middle of the side that faces the flow.
      const onSide = (box: typeof from, p: number[], sign: number) =>
        across
          ? p[0] === box.x + (sign * box.w) / 2 && p[1] === box.y
          : p[1] === box.y + (sign * box.h) / 2 && p[0] === box.x;
      const sign = link.reversed ? -1 : 1;
      assert.ok(onSide(from, start, sign), `${link.id} leaves its box's border`);
      assert.ok(onSide(to, end, -sign), `${link.id} meets its box's border`);
    }
  }
});

test("a tree's boxes never overlap where ECharts places them, at any size", () => {
  // Positions as ECharts' tree sets them: the tidy tree's units stretched
  // over the series' box, the levels evenly; whatever the size, the boxes
  // either sit apart or are drawn as markers.
  const rows = Array.from({ length: 14 }, (_, i) => ({
    caller: i < 3 ? "gateway" : `svc-${i % 3}`,
    callee: `svc-${i}`,
    tier: "service",
    requests: 100 + i,
  })).filter((r) => r.caller !== r.callee);
  const data = { columns: SERVICE_MAP.columns, rows };
  let drawn = 0;
  for (const orient of ["LR", "TB", "RL", "BT"]) {
    for (const width of [300, 500, 800, 1200]) {
      for (const height of [200, 320, 600]) {
        const size = { width, height };
        const panel = graph({ ...BLOCKS, layout: "tree", orient });
        const option = graphChart(panel, data, { ...CTX, size });
        const series = seriesOf(option) as unknown as {
          data: BlockItem[];
          left: number;
          right: number;
          top: number;
          bottom: number;
        };
        const [root] = series.data;
        if (!root?.label.width) {
          assert.equal(graphNotice(panel, data, size)?.label, "Drawn as markers");
          continue;
        }
        drawn++;
        const boxes = new Map<string, { w: number; h: number }>();
        const walk = (item: BlockItem) => {
          boxes.set(item.id, {
            w: (item.label.width as number) + 16,
            h: 0,
          });
          item.children?.forEach(walk);
        };
        walk(root);
        type Shape = { id: string; children: Shape[] };
        const shape = (item: BlockItem): Shape => ({
          id: item.id,
          children: (item.children ?? []).map(shape),
        });
        // As drawn, and with any one branch closed, which ECharts lays out again.
        const full = shape(root);
        const closed = (tree: Shape, id: string): Shape => ({
          id: tree.id,
          children: tree.id === id ? [] : tree.children.map((c) => closed(c, id)),
        });
        for (const variant of [
          full,
          ...[...boxes.keys()].map((id) => closed(full, id)),
        ]) {
          const { places, span } = tidyTree(variant, false);
          const w = width - series.left - series.right;
          const h = height - series.top - series.bottom;
          const depths = Math.max(...places.map((p) => p.depth));
          const sideways = orient === "LR" || orient === "RL";
          const at = places.map((p) => {
            const breadth = (p.x / span) * (sideways ? h : w);
            const level = ((p.depth - 1) / (depths - 1 || 1)) * (sideways ? w : h);
            const box = boxes.get(p.node.id) as { w: number };
            return sideways
              ? { x: level, y: breadth, w: box.w, h: 40 }
              : { x: breadth, y: level, w: box.w, h: 40 };
          });
          for (let i = 0; i < at.length; i++) {
            for (let j = i + 1; j < at.length; j++) {
              assert.ok(
                !overlap(at[i] as never, at[j] as never),
                `${orient} at ${width}×${height}: ${i} and ${j}`,
              );
            }
          }
        }
      }
    }
  }
  assert.ok(drawn > 4, "and at a fair size they are drawn");
});

test("the tidy tree is ECharts' own: the same places, siblings a unit apart", async () => {
  interface Helper {
    init(root: E): void;
    separation(): unknown;
    firstWalk(node: E, separation: unknown): void;
    secondWalk(node: E): void;
  }
  // ECharts' own tidy tree, which has no types of its own.
  const at = "echarts/lib/chart/tree/layoutHelper.js";
  const helper = (await import(at)) as Helper;
  interface E {
    children: E[];
    parentNode: E | null;
    isExpand: boolean;
    depth: number;
    hierNode?: unknown;
    layout?: { x: number };
    getLayout(): { x: number };
    setLayout(l: { x: number }): void;
  }
  const echartsNode = (children: E[], depth: number): E => {
    const n: E = {
      children,
      parentNode: null,
      isExpand: true,
      depth,
      getLayout() {
        return this.layout as { x: number };
      },
      setLayout(l) {
        this.layout = { ...this.layout, ...l };
      },
    };
    for (const c of children) c.parentNode = n;
    return n;
  };
  // Seeded random trees, ECharts' walk and ours side by side.
  let seed = 3;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let t = 0; t < 30; t++) {
    interface Shape {
      children: Shape[];
    }
    const build = (depth: number): Shape => ({
      children:
        depth > 4 || (depth > 1 && random() < 0.35)
          ? []
          : Array.from({ length: 1 + Math.floor(random() * 3) }, () => build(depth + 1)),
    });
    const mine = build(1);
    const toE = (n: Shape, depth: number): E =>
      echartsNode(
        n.children.map((c) => toE(c, depth + 1)),
        depth,
      );
    const real = toE(mine, 1);
    const virtual = echartsNode([real], 0);
    const all: E[] = [];
    const collect = (n: E) => {
      all.push(n);
      n.children.forEach(collect);
    };
    collect(real);
    helper.init(virtual);
    const sep = helper.separation();
    // Children before their parent, left to right: ECharts' `eachAfter`.
    const after = (n: E) => {
      n.children.forEach(after);
      helper.firstWalk(n, sep);
    };
    after(real);
    (virtual.hierNode as { modifier: number }).modifier = -(
      real.hierNode as { prelim: number }
    ).prelim;
    for (const n of all) helper.secondWalk(n);
    const theirs = all.map((n) => n.getLayout().x);
    const { places } = tidyTree(mine);
    const shift = (places[0]?.x ?? 0) - (theirs[0] ?? 0);
    assert.deepEqual(
      places.map((p) => Math.round((p.x - shift) * 1e6) / 1e6),
      theirs.map((x) => Math.round(x * 1e6) / 1e6),
      `tree ${t}`,
    );
  }
});

test("a force graph's boxes push apart by their size and fit or fall back", () => {
  const panel = graph({ ...BLOCKS, layout: "force" });
  const option = graphChart(panel, SERVICE_MAP, {
    ...CTX,
    size: { width: 680, height: 420 },
  });
  const series = seriesOf(option) as unknown as {
    data: BlockItem[];
    force: { repulsion: number[]; edgeLength: number; gravity: number };
  };
  const boxes = series.data.filter(isBox);
  assert.equal(boxes.length, 8);
  const radii = boxes.map((b) => {
    const [w, h] = b.symbolSize as number[];
    return Math.hypot(w as number, h as number) / 2;
  });
  // Each box's value is its half-diagonal, mapped onto the repulsion's range.
  assert.deepEqual(
    boxes.map((b) => b.value),
    radii,
  );
  assert.deepEqual(series.force.repulsion, [
    Math.round(Math.min(...radii) * 80),
    Math.round(Math.max(...radii) * 80),
  ]);
  assert.ok(series.force.edgeLength >= 2 * Math.max(...radii));
  // A small panel draws markers, and says so.
  const small = { width: 240, height: 160 };
  assert.ok(
    !seriesOf(graphChart(panel, SERVICE_MAP, { ...CTX, size: small })).data.some(isBox),
  );
  assert.equal(graphNotice(panel, SERVICE_MAP, small)?.label, "Drawn as markers");
});

test("too small for its boxes, a graph draws markers with a notice; never half-overlapping boxes", () => {
  for (const layout of ["tree", "dag"]) {
    const panel = graph({ ...BLOCKS, layout });
    const small = { width: 160, height: 100 };
    const option = graphChart(panel, CALLS, { ...CTX, size: small });
    const items = seriesOf(option).data;
    assert.ok(
      !items.some((d) => d.label?.width !== undefined),
      `${layout} draws markers`,
    );
    const notice = graphNotice(panel, CALLS, small);
    assert.equal(notice?.label, "Drawn as markers", layout);
    assert.match(notice?.detail ?? "", /do not fit/);
    // A marker graph asked for has nothing to say at any size.
    assert.equal(graphNotice(graph({ ...EDGES, layout }), CALLS, small), undefined);
  }
  // A tree that is not one says both.
  assert.match(
    graphNotice(graph({ ...BLOCKS, layout: "tree" }), SERVICE_MAP, {
      width: 160,
      height: 100,
    })?.detail ?? "",
    /two parents.*do not fit/,
  );
  // A long name is cut with an ellipsis, never wider than the cap; whole in the table.
  const long = {
    columns: SERVICE_MAP.columns,
    rows: [
      {
        caller: "gateway",
        callee: "a-service-with-a-very-long-name-indeed",
        tier: "service",
        requests: 1,
      },
    ],
  };
  const option = graphChart(graph({ ...BLOCKS, layout: "dag" }), long, CTX);
  for (const b of seriesOf(option).data.filter(isBox)) {
    assert.ok(((b.symbolSize as number[])[0] as number) <= GRAPH_BLOCK_MAX_WIDTH);
    assert.equal((b.label as { overflow?: string }).overflow, "truncate");
  }
  assert.ok(
    graphTable(graph({ ...BLOCKS, layout: "dag" }), long).rows.some((r) =>
      r.includes("a-service-with-a-very-long-name-indeed"),
    ),
  );
});

test("a box is its node's datum; a tree branch's knob opens and closes it; the table is unchanged", () => {
  for (const layout of ["tree", "dag", "force"]) {
    const blocks = graph({ ...BLOCKS, layout });
    const markers = graph({ ...BLOCKS, layout, node: "marker" });
    assert.deepEqual(
      graphTable(blocks, SERVICE_MAP),
      graphTable(markers, SERVICE_MAP),
      layout,
    );
    for (const id of ["gateway", "api", "redis"]) {
      assert.deepEqual(
        graphClickDatum(blocks, SERVICE_MAP, id),
        graphClickDatum(markers, SERVICE_MAP, id),
      );
    }
  }
  const dag = seriesOf(graphChart(graph({ ...BLOCKS, layout: "dag" }), SERVICE_MAP, CTX));
  // An edge's click is its datum, though it is drawn between ports; a port is none.
  const edge = dag.links?.[0] as Link;
  assert.equal(
    graphClickDatum(graph({ ...BLOCKS, layout: "dag" }), SERVICE_MAP, edge.id)?.row
      .source,
    edge.from,
  );
  assert.equal(
    graphClickDatum(graph({ ...BLOCKS, layout: "dag" }), SERVICE_MAP, edge.source),
    null,
  );
  // A tree's box is its label, so a click on it is a datum; a branch's knob
  // is its symbol, which toggles.
  const tree = seriesOf(
    graphChart(graph({ ...BLOCKS, layout: "tree", orient: "TB" }), CALLS, CTX),
  );
  const root = tree.data[0] as BlockItem & { symbolSize: number; symbolOffset: number[] };
  assert.equal(root.symbolSize, 8);
  assert.ok(
    (root.symbolOffset[1] as number) > 0,
    "below the box, the way the tree grows",
  );
  const target = { type: "text", parent: { type: "path" } };
  assert.equal(treeClickPart({ seriesType: "tree", event: { target } }), "datum");
});

test("the zoom and pan controls show exactly where a graph roams (#682)", () => {
  // A force graph roams by its series, a marker directed graph by its axes'
  // inside zoom: both get the buttons and keys.
  assert.equal(roamKind(graphChart(graph(FORCE), DEPS, CTX)), "series");
  assert.equal(roamKind(graphChart(graph(DAG), DEPS, CTX)), "axes");
  // A tree does not roam, and a directed graph drawn as boxes fits its panel
  // whole with its zoom off: nothing to zoom, so no controls. (Rows that are
  // not a tree fall back to a directed graph, which does.)
  const tree: PanelData = {
    columns: ["from", "to"],
    rows: [
      { from: "web", to: "api" },
      { from: "web", to: "auth" },
    ],
  };
  assert.equal(
    roamKind(graphChart(graph({ ...DAG, layout: "tree" }), tree, CTX)),
    undefined,
  );
  assert.equal(
    roamKind(
      graphChart(graph({ ...BLOCKS, layout: "dag", direction: "LR" }), SERVICE_MAP, {
        ...CTX,
        size: WIDE,
      }),
    ),
    undefined,
  );
});
