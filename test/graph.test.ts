import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ctrlZoomSeries, treeClickPart, withTreeState } from "@/components/charts/EChart";
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
import { DEFAULT_CHART_THEME, inkOn } from "@/lib/color/chart-theme";
import { AA_TEXT, contrastRatio, hexToRgb, parseThemeTokens } from "@/lib/color/contrast";
import { graphLayout } from "@/lib/graph/layout";
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
    repulsion: number;
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
    forceSpacing(5),
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
