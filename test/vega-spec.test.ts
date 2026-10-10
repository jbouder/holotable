import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "@/lib/auth/authorize";
import { resolveAndValidateDashboard } from "@/lib/dashboard-service";
import { type Dashboard, Panel, SPEC_VERSION } from "@/lib/ir";
import { tokenHex } from "@/lib/panels/colors";
import { panelKind } from "@/lib/panels/registry";
import { SourceConfig, type SourceRecord } from "@/lib/registry";
import { resolveVegaColors, vegaColor } from "@/lib/vega/colors";
import { VEGA_SPEC_MAX_BYTES, vegaLiteIssues } from "@/lib/vega/walk";

/*
 * A custom visual's spec (#405, phase 2): the structural walk the IR runs on
 * every parse, the color names it allows and how they are painted, and the
 * compile the server runs where a dashboard is saved.
 */

const LAYOUT = { x: 0, y: 0, w: 12, h: 4 };
const ROWS = { name: "rows" };

const BAND = {
  data: ROWS,
  layer: [
    {
      mark: "area",
      encoding: {
        x: { field: "t", type: "temporal" },
        y: { field: "p5", type: "quantitative" },
        y2: { field: "p95" },
        color: { value: "palette-0" },
        opacity: { value: 0.25 },
      },
    },
    {
      mark: { type: "line", tooltip: true },
      encoding: {
        x: { field: "t", type: "temporal" },
        y: { field: "p50", type: "quantitative" },
        color: {
          field: "host",
          type: "nominal",
          scale: { range: ["info", "teal", "purple"] },
        },
      },
    },
    { mark: "rule", encoding: { y: { datum: 500 }, color: { value: "danger" } } },
  ],
};

const paths = (spec: unknown) => vegaLiteIssues(spec).map((i) => i.path.join("."));
const messages = (spec: unknown) =>
  vegaLiteIssues(spec)
    .map((i) => i.message)
    .join("\n");

test("a band, a line per host and a rule, in token colors, passes", () => {
  assert.deepEqual(vegaLiteIssues(BAND), []);
  assert.deepEqual(
    vegaLiteIssues({
      ...BAND,
      $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    }),
    [],
  );
  // Small multiples and a computed field are views no kind draws: allowed.
  assert.deepEqual(
    vegaLiteIssues({
      data: ROWS,
      transform: [{ calculate: "datum.used / datum.size", as: "share" }],
      facet: { field: "region", type: "nominal" },
      spec: { mark: "bar", encoding: { x: { field: "host", type: "nominal" } } },
    }),
    [],
  );
});

test("the spec reads the panel's rows and nothing else", () => {
  assert.deepEqual(paths({ mark: "point" }), ["data"]);
  assert.deepEqual(paths({ data: { values: [{ a: 1 }] }, mark: "point" }), ["data"]);
  assert.deepEqual(paths({ data: { name: "other" }, mark: "point" }), ["data"]);
  assert.deepEqual(paths({ data: ROWS, datasets: { x: [] }, mark: "point" }), [
    "datasets",
  ]);
  // A nested data, or a lookup from another dataset, is refused too.
  assert.deepEqual(
    paths({
      data: ROWS,
      transform: [
        { lookup: "id", from: { data: { values: [] }, key: "id", fields: ["name"] } },
      ],
      mark: "point",
    }),
    ["transform.0.from.data"],
  );
});

test("nothing in a spec can reach the network or the page", () => {
  for (const [spec, path] of [
    [{ data: { url: "https://example.com/d.json" }, mark: "point" }, "data"],
    [{ data: ROWS, mark: "point", encoding: { href: { field: "u" } } }, "encoding.href"],
    [{ data: ROWS, mark: { type: "point", href: "https://x.test" } }, "mark.href"],
    [{ data: ROWS, mark: "image", encoding: { url: { field: "u" } } }, "mark"],
    [{ data: ROWS, mark: "point", usermeta: { embedOptions: {} } }, "usermeta"],
    [
      {
        data: ROWS,
        mark: "point",
        params: [{ name: "p", bind: { input: "range", element: "#app" } }],
      },
      "params.0.bind.element",
    ],
    [{ data: ROWS, mark: "point", config: { background: "#fff" } }, "config"],
  ] as const) {
    assert.ok(paths(spec).includes(path), `${path}: ${JSON.stringify(paths(spec))}`);
  }
  assert.ok(paths({ data: ROWS, mark: "image" }).includes("mark"));
  assert.match(
    messages({ data: ROWS, $schema: "https://evil.test/s.json", mark: "point" }),
    /\$schema/,
  );
});

test("colors are token names, chart colors by index or transparent, never literals", () => {
  for (const literal of ["#ff0000", "red", "rgb(1,2,3)"]) {
    assert.ok(
      paths({ data: ROWS, mark: { type: "bar", color: literal } }).includes("mark.color"),
    );
    assert.ok(
      paths({
        data: ROWS,
        mark: "bar",
        encoding: { color: { value: literal } },
      }).includes("encoding.color.value"),
    );
    assert.ok(
      paths({
        data: ROWS,
        mark: "bar",
        encoding: {
          color: { field: "a", type: "nominal", scale: { range: ["info", literal] } },
        },
      }).includes("encoding.color.scale.range.1"),
    );
    assert.ok(
      paths({
        data: ROWS,
        mark: "bar",
        encoding: { x: { field: "a", type: "nominal", axis: { labelColor: literal } } },
      }).includes("encoding.x.axis.labelColor"),
    );
  }
  assert.ok(
    paths({
      data: ROWS,
      mark: "bar",
      encoding: { color: { field: "a", type: "nominal", scale: { scheme: "reds" } } },
    }).includes("encoding.color.scale.scheme"),
  );
  // A conditional color is held to the same names.
  assert.ok(
    paths({
      data: ROWS,
      mark: "bar",
      encoding: {
        color: { condition: { test: "datum.a > 1", value: "#f00" }, value: "info" },
      },
    }).includes("encoding.color.condition.value"),
  );
  assert.deepEqual(
    vegaLiteIssues({
      data: ROWS,
      mark: { type: "bar", fill: "transparent", stroke: "palette-3" },
    }),
    [],
  );
});

test("a mark or field type that does not exist is named, before the compiler sees it", () => {
  assert.match(messages({ data: ROWS, mark: "bars" }), /"bars" is not a mark/);
  assert.match(
    messages({
      data: ROWS,
      mark: "bar",
      encoding: { x: { field: "a", type: "number" } },
    }),
    /"number" is not a field type/,
  );
});

test("a spec that draws nothing, or a facet with no spec, is named", () => {
  assert.match(messages({ data: ROWS }), /draws nothing/);
  assert.match(messages({ data: ROWS, repeat: ["a"] }), /a repeat draws its "spec"/);
  assert.match(
    messages({ data: ROWS, facet: { field: "a", type: "nominal" } }),
    /a facet draws/,
  );
});

test("a spec is capped in size and depth", () => {
  const big = { data: ROWS, mark: "text", description: "x".repeat(VEGA_SPEC_MAX_BYTES) };
  assert.match(messages(big), /bytes/);
  let deep: Record<string, unknown> = { mark: "point" };
  for (let i = 0; i < 30; i++) deep = { layer: [deep] };
  assert.match(messages({ data: ROWS, ...deep }), /deeper/);
});

test("the IR holds a vega panel's options to the walk", () => {
  const parse = (options: unknown) =>
    Panel.safeParse({
      id: "v",
      title: "Band",
      viz: "vega",
      query: { sourceId: "s", sql: "SELECT 1" },
      options,
      layout: LAYOUT,
    });
  assert.equal(parse({ spec: BAND }).success, true);
  const refused = parse({ spec: { ...BAND, data: { url: "https://x.test" } } });
  assert.equal(refused.success, false);
  assert.deepEqual(refused.error?.issues[0]?.path, ["options"]);
  assert.match(refused.error?.issues[0]?.message ?? "", /spec\.data: /);
  assert.equal(parse({}).success, false);
  assert.equal(parse({ spec: BAND, extra: 1 }).success, false);
  // A panel switched to the kind in the editor starts with a spec that passes.
  assert.equal(parse(panelKind("vega").starterOptions?.("Band")).success, true);
});

test("color names are painted the way the other kinds paint them", () => {
  assert.equal(vegaColor("danger"), tokenHex("danger"));
  assert.match(vegaColor("palette-0"), /^#[0-9a-f]{6}$/);
  assert.equal(vegaColor("transparent"), "transparent");
  const painted = resolveVegaColors(BAND) as typeof BAND;
  const rule = painted.layer[2] as { encoding: { color: { value: string } } };
  assert.equal(rule.encoding.color.value, tokenHex("danger"));
  const line = painted.layer[1] as {
    encoding: { color: { scale: { range: string[] } } };
  };
  assert.deepEqual(line.encoding.color.scale.range, [
    tokenHex("info"),
    tokenHex("teal"),
    tokenHex("purple"),
  ]);
  // The stored spec keeps its names.
  assert.equal((BAND.layer[2] as typeof rule).encoding.color.value, "danger");
});

// --- Where a dashboard is saved ----------------------------------------------

const source: SourceRecord = {
  id: "src",
  workspaceId: "ws-1",
  name: "src",
  kind: "timescaledb",
  config: SourceConfig.parse({
    host: "postgres",
    port: 5432,
    database: "holotable",
    schema: "metrics",
    ssl: false,
    tables: [
      {
        name: "latency",
        timeField: "ts",
        columns: [
          { name: "ts", type: "timestamp with time zone" },
          { name: "p50", type: "double precision" },
        ],
      },
    ],
  }),
  secretRef: "TS_SRC",
  catalogRefreshedAt: new Date().toISOString(),
  catalogMissingTables: [],
  createdBy: "user-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  tombstonedAt: null,
};

function dashboard(spec: unknown): Dashboard {
  return {
    specVersion: SPEC_VERSION,
    title: "Custom",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 30_000,
    panels: [
      {
        id: "custom",
        title: "Custom",
        viz: "vega",
        query: { sourceId: "src", sql: "SELECT ts, p50 FROM latency", timeField: "ts" },
        options: { spec },
        layout: LAYOUT,
      },
    ],
  } as Dashboard;
}

test("a dashboard saves when its custom visual compiles, and is refused with the compiler's message when not", async () => {
  const lookup = async (id: string) => (id === "src" ? source : null);
  const ok = await resolveAndValidateDashboard(
    dashboard({
      data: ROWS,
      mark: "line",
      encoding: {
        x: { field: "ts", type: "temporal" },
        y: { field: "p50", type: "quantitative" },
      },
    }),
    lookup,
  );
  assert.equal(ok.workspaceId, "ws-1");

  // Passes the walk, fails the compiler: a layer that is not a list.
  const err = await resolveAndValidateDashboard(
    dashboard({ data: ROWS, layer: "line" }),
    lookup,
  ).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof HttpError);
  assert.equal(err.status, 400);
  assert.match(err.message, /^panel "custom": the Vega-Lite spec does not compile: /);
});
