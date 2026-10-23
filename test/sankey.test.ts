import assert from "node:assert/strict";
import { test } from "node:test";
import { graphEdgeId } from "@/components/charts/graph";
import type { PanelData } from "@/components/charts/options";
import {
  sankeyChart,
  sankeyClickDatum,
  sankeyNet,
  sankeyNotice,
  sankeyProblem,
  sankeyShape,
  sankeyTable,
  sankeyStages,
} from "@/components/charts/sankey";
import { DEFAULT_CHART_THEME, inkOn } from "@/lib/color/chart-theme";
import { Panel } from "@/lib/ir";
import { LOCAL_TIME_DISPLAY } from "@/lib/time-display";

/*
 * The Sankey kind (#625): the graph's rows read as weighted flows, a value
 * required on every one and duplicate flows summed, refused naming a node
 * when they cycle, drawn with labels that read on their node's color.
 */

const CTX = { display: LOCAL_TIME_DISPLAY, theme: DEFAULT_CHART_THEME };
const LAYOUT = { x: 0, y: 0, w: 12, h: 4 };

const parse = (options: unknown) =>
  Panel.safeParse({
    id: "s",
    title: "Request flow",
    viz: "sankey",
    query: { sourceId: "s", sql: "SELECT 1" },
    ...(options === undefined ? {} : { options }),
    layout: LAYOUT,
  });

function sankey(options: Record<string, unknown>): Panel {
  const parsed = parse(options);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  return parsed.data;
}

const REQUESTS: PanelData = {
  columns: ["period", "service", "route", "status", "requests"],
  rows: [
    { period: "t1", service: "api", route: "/login", status: 200, requests: 40 },
    { period: "t1", service: "api", route: "/login", status: 500, requests: 2 },
    { period: "t1", service: "web", route: "/login", status: 200, requests: 10 },
    { period: "t1", service: "web", route: "/search", status: 404, requests: 5 },
    { period: "t2", service: "api", route: "/login", status: 200, requests: 8 },
  ],
};
const STAGES = { path: ["service", "route", "status"], value: "requests" };

const CALLS: PanelData = {
  columns: ["from", "to", "bytes"],
  rows: [
    { from: "lb", to: "api", bytes: 10 },
    { from: "api", to: "db", bytes: 6 },
    { from: "lb", to: "api", bytes: 5 },
    { from: "api", to: "cache", bytes: null },
  ],
};

test("value is required, symbols do not apply, and orient is LR or TB", () => {
  assert.equal(parse(undefined).success, false, "no options, no value");
  assert.equal(parse({ source: "a", target: "b" }).success, false);
  assert.equal(parse({ value: "v", orient: "TB" }).success, true);
  assert.equal(parse({ value: "v", orient: "RL" }).success, false);
  assert.equal(parse({ value: "v", symbol: "server" }).success, false);
  assert.equal(
    parse({ value: "v", path: ["one"] }).success,
    false,
    "two stages at least",
  );
  assert.notEqual(
    sankeyShape(sankey({ value: "v" })),
    sankeyShape(sankey({ value: "v", orient: "TB" })),
  );
});

test("path columns are stages: a value is one node per stage, and flows sum over rows", () => {
  const net = sankeyNet(sankey(STAGES), REQUESTS);
  assert.equal(net.problem, undefined);
  // api, web; /login, /search; 200, 500, 404.
  assert.deepEqual(
    net.nodes.map((n) => n.name),
    ["api", "/login", "200", "500", "web", "/search", "404"],
  );
  const flow = (a: string, b: string) =>
    net.edges.find((e) => e.id === graphEdgeId(a, b));
  // Two periods of api → /login are one flow: 40 + 2 + 8.
  assert.equal(flow("0\u001fapi", "1\u001f/login")?.value, 50);
  // Every 200 is one node, whichever route led to it.
  assert.equal(flow("1\u001f/login", "2\u001f200")?.value, 58);
  assert.equal(net.nodes.find((n) => n.name === "/login")?.value, 60);
  assert.deepEqual(net.totals.get("1\u001f/login"), { in: 60, out: 60 });
});

test("edge rows are the graph's, duplicates summed; a row with no volume is left out and said", () => {
  const panel = sankey({ source: "from", target: "to", value: "bytes" });
  const net = sankeyNet(panel, CALLS);
  assert.deepEqual(
    net.edges.map((e) => [e.source, e.target, e.value]),
    [
      ["lb", "api", 15],
      ["api", "db", 6],
    ],
  );
  assert.equal(net.dropped, 1);
  assert.match(
    sankeyNotice(panel, CALLS)?.detail ?? "",
    /^1 row has no positive value in "bytes"/,
  );
  assert.equal(sankeyNotice(sankey(STAGES), REQUESTS), undefined);
  // A value column the rows lack is the problem, named.
  assert.match(
    sankeyProblem(sankey({ value: "volume" }), CALLS) ?? "",
    /value column "volume" is not in the rows/,
  );
  // No rows yet is nothing wrong.
  assert.equal(
    sankeyProblem(sankey({ value: "volume" }), { columns: [], rows: [] }),
    undefined,
  );
});

test("a cycle is refused naming a node on it, and so is a flow into itself", () => {
  const panel = sankey({ source: "from", target: "to", value: "n" });
  const cycle = {
    columns: ["from", "to", "n"],
    rows: [
      { from: "start", to: "a", n: 1 },
      { from: "a", to: "b", n: 1 },
      { from: "b", to: "c", n: 1 },
      { from: "c", to: "a", n: 1 },
    ],
  };
  const problem = sankeyProblem(panel, cycle) ?? "";
  assert.match(problem, /^"[abc]" is on a cycle \(/);
  assert.match(problem, /a → b → c → a|b → c → a → b|c → a → b → c/);
  assert.match(problem, /layout "dag"/);
  const self = { columns: ["from", "to", "n"], rows: [{ from: "a", to: "a", n: 1 }] };
  assert.match(sankeyProblem(panel, self) ?? "", /^"a" flows into itself/);
  // Nothing is drawn (ECharts throws on a cycle), and nothing is clickable.
  const series = (sankeyChart(panel, cycle, CTX).series as { data: unknown[] }[])[0];
  assert.deepEqual(series?.data, []);
  assert.equal(sankeyClickDatum(panel, cycle, "a"), null);
});

test("a Sankey draws its stages with flows as wide as their volume and labels that read", () => {
  const option = sankeyChart(sankey({ ...STAGES, orient: "TB" }), REQUESTS, CTX);
  const series = (
    option.series as {
      type: string;
      orient: string;
      nodeAlign: string;
      lineStyle: { color: string };
      data: {
        id: string;
        itemStyle: { color: string };
        label: { color: string; backgroundColor: string };
      }[];
      links: { source: string; target: string; value: number }[];
    }[]
  )[0];
  assert.equal(series?.type, "sankey");
  assert.equal(series?.orient, "vertical");
  assert.equal(series?.nodeAlign, "justify");
  assert.equal(series?.lineStyle.color, "gradient");
  assert.equal(series?.data.length, 7);
  assert.equal(series?.links.length, 6);
  for (const node of series?.data ?? []) {
    assert.equal(node.label.backgroundColor, node.itemStyle.color);
    assert.equal(node.label.color, inkOn(node.itemStyle.color));
  }
  const horizontal = sankeyChart(sankey(STAGES), REQUESTS, CTX);
  assert.equal((horizontal.series as { orient: string }[])[0]?.orient, "horizontal");
});

test("a node is a datum with its name and value, a flow with its source, target and value", () => {
  const panel = sankey(STAGES);
  assert.deepEqual(sankeyClickDatum(panel, REQUESTS, "1\u001f/login"), {
    row: { route: "/login", node: "/login", requests: 60, value: 60 },
    series: "/login",
  });
  assert.deepEqual(
    sankeyClickDatum(panel, REQUESTS, graphEdgeId("1\u001f/login", "2\u001f500")),
    {
      row: {
        route: "/login",
        status: "500",
        requests: 2,
        source: "/login",
        target: "500",
        value: 2,
      },
      series: "/login → 500",
    },
  );
  const edges = sankey({ source: "from", target: "to", value: "bytes" });
  const node = sankeyClickDatum(edges, CALLS, "api");
  assert.equal(node?.row.node, "api");
  assert.equal(node?.row.value, 15);
  assert.ok(!("parent" in (node?.row ?? {})), "a Sankey node has no one parent");
});

test("the table is one row per flow, with each end's total out and in", () => {
  const table = sankeyTable(sankey(STAGES), REQUESTS);
  assert.equal(table.caption, "Flows of Request flow: 6 flows.");
  assert.deepEqual(table.columns, [
    "from",
    "to",
    "requests",
    "from total out",
    "to total in",
  ]);
  assert.deepEqual(
    table.rows.find((r) => r[0] === "/login" && r[1] === "200"),
    ["/login", "200", "58", "60", "58"],
  );
  assert.equal(table.datums[0]?.row.source, "api");
  assert.equal(table.labels?.[0], "api → /login");
  const edges = sankeyTable(
    sankey({ source: "from", target: "to", value: "bytes" }),
    CALLS,
  );
  assert.deepEqual(edges.columns, [
    "from",
    "to",
    "bytes",
    "from total out",
    "to total in",
  ]);
});

test("a flow's stages are its columns, with every end in the last (#643)", () => {
  const nodes = ["a", "b", "x", "y", "z"].map((id) => ({ id, name: id }));
  const edge = (source: string, target: string) => ({
    id: `${source}>${target}`,
    source,
    target,
    row: {},
  });
  // a → x → y, b → z: z ends early but is drawn in the last stage.
  const shape = sankeyStages({
    nodes: nodes as never,
    edges: [edge("a", "x"), edge("x", "y"), edge("b", "z")] as never,
  });
  assert.deepEqual(shape, { stages: 3, most: 2 });
  assert.deepEqual(sankeyStages({ nodes: [], edges: [] }), { stages: 0, most: 0 });
});
