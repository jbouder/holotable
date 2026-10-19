import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { treeClickPart, withTreeState } from "@/components/charts/EChart";
import {
  GRAPH_NODES_MAX,
  GRAPH_ROOT_ID,
  graphChart,
  graphNodes,
  graphShape,
  graphTable,
  graphTree,
} from "@/components/charts/graph";
import type { PanelData } from "@/components/charts/options";
import { DEFAULT_CHART_THEME, inkOn } from "@/lib/color/chart-theme";
import { AA_TEXT, contrastRatio, hexToRgb, parseThemeTokens } from "@/lib/color/contrast";
import { GRAPH_SYMBOLS, ICON_PATHS, isIcon } from "@/lib/graph/symbols";
import { Panel } from "@/lib/ir";
import { LOCAL_TIME_DISPLAY } from "@/lib/time-display";

/*
 * The graph kind (#623): edge rows or path columns as one tree, refused with
 * the node named when they are not a tree, drawn with labels that read on
 * their node's color and symbols only from the allowlist.
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
    caller: "orders",
    callee: "orders-db",
    requests: 30,
    tier: "store",
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
  });
});

test("a node with two parents is refused, naming it", () => {
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

test("a cycle is refused, naming a node on it, and so is a node pointing at itself", () => {
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
