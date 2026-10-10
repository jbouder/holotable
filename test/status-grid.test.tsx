import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PanelData } from "@/components/charts/options";
import { StatusGridView } from "@/components/panels/status-grid";
import { Panel } from "@/lib/ir";
import { fallbackToken } from "@/lib/panels/colors";
import { STATUS_GRID_MAX, statusGrid } from "@/lib/panel-reading";

/*
 * The status grid (#404): one tile per entity, as the function that turns
 * rows into tiles, and the body that draws them.
 */

const LAYOUT = { x: 0, y: 0, w: 6, h: 4 };
const T = (m: number) => `2026-10-09T10:0${m}:00Z`;

function grid(
  options: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  return Panel.parse({
    id: "g",
    title: "Hosts",
    viz: "status-grid",
    query: { sourceId: "s", sql: "SELECT 1", timeField: "minute" },
    options,
    layout: LAYOUT,
    ...extra,
  });
}

const SERIES: PanelData = {
  columns: ["minute", "host", "cpu"],
  rows: [
    { minute: T(0), host: "web-10", cpu: 20 },
    { minute: T(0), host: "web-2", cpu: 95 },
    { minute: T(1), host: "web-10", cpu: 75 },
    { minute: T(1), host: "web-2", cpu: 30 },
  ],
};

const STEPS = [
  { value: 0, color: "success" },
  { value: 70, color: "warning" },
  { value: 90, color: "danger" },
];

test("a tile per entity, showing its latest row", () => {
  const { tiles, overflow } = statusGrid(grid(), SERIES);
  assert.equal(overflow, 0);
  assert.deepEqual(
    tiles.map((t) => [t.label, t.value]),
    // Sorted by label, numerically: web-2 before web-10.
    [
      ["web-2", 30],
      ["web-10", 75],
    ],
  );
  assert.deepEqual(tiles[1]?.row, { minute: T(1), host: "web-10", cpu: 75 });
});

test("thresholds color a tile, and below every step it stays neutral", () => {
  const { tiles } = statusGrid(grid({ thresholds: STEPS }), SERIES);
  assert.deepEqual(
    tiles.map((t) => t.color),
    ["success", "warning"],
  );
  const above = statusGrid(
    grid({ thresholds: [{ value: 50, color: "danger" }] }),
    SERIES,
  );
  assert.deepEqual(
    above.tiles.map((t) => t.color),
    [undefined, "danger"],
  );
});

test("a state column colors by state, as a state timeline does, then by a stable fallback", () => {
  const data: PanelData = {
    columns: ["host", "state"],
    rows: [
      { host: "a", state: "ok" },
      { host: "b", state: "draining" },
      { host: "c", state: "DOWN" },
    ],
  };
  const { tiles } = statusGrid(
    grid({ state: "state", states: [{ state: "ok", color: "success" }] }),
    data,
  );
  assert.deepEqual(
    tiles.map((t) => [t.label, t.state, t.color, t.text]),
    [
      ["a", "ok", "success", ""],
      ["b", "draining", fallbackToken("draining"), ""],
      // The state timeline's defaults: a state means the same color on both.
      ["c", "DOWN", "danger", ""],
    ],
  );
});

test("values are formatted per the panel", () => {
  const { tiles } = statusGrid(grid({ decimals: 0 }, { format: "percent" }), SERIES);
  assert.deepEqual(
    tiles.map((t) => t.text),
    ["30%", "75%"],
  );
});

test("sort by value puts the largest first and a tile without a number last", () => {
  const data: PanelData = {
    columns: ["host", "cpu"],
    rows: [
      { host: "a", cpu: 10 },
      { host: "b", cpu: null },
      { host: "c", cpu: 80 },
    ],
  };
  assert.deepEqual(
    statusGrid(grid({ sort: "value" }), data).tiles.map((t) => t.label),
    ["c", "a", "b"],
  );
  assert.deepEqual(
    statusGrid(grid({ sort: "none" }), data).tiles.map((t) => t.label),
    ["a", "b", "c"],
  );
});

test("sort none keeps the order entities last appeared in", () => {
  assert.deepEqual(
    statusGrid(grid({ sort: "none" }), SERIES).tiles.map((t) => t.label),
    ["web-10", "web-2"],
  );
});

test("named columns win over the guess", () => {
  const data: PanelData = {
    columns: ["region", "host", "mem", "cpu"],
    rows: [{ region: "eu", host: "a", mem: 40, cpu: 90 }],
  };
  const guessed = statusGrid(grid(), data).tiles[0];
  assert.deepEqual([guessed?.label, guessed?.value], ["eu", 40]);
  const named = statusGrid(grid({ entity: "host", value: "cpu" }), data).tiles[0];
  assert.deepEqual([named?.label, named?.value], ["a", 90]);
});

test("tiles past the cap are counted, not drawn", () => {
  const rows = Array.from({ length: STATUS_GRID_MAX + 7 }, (_, i) => ({
    host: `h${i}`,
    cpu: i,
  }));
  const { tiles, overflow } = statusGrid(grid(), { columns: ["host", "cpu"], rows });
  assert.equal(tiles.length, STATUS_GRID_MAX);
  assert.equal(overflow, 7);
});

test("no rows, or rows of nothing it can read, draw no tiles rather than throwing", () => {
  assert.deepEqual(statusGrid(grid(), { columns: [], rows: [] }).tiles, []);
  const odd = statusGrid(grid(), { columns: ["x"], rows: [{ x: { nested: true } }] });
  assert.equal(odd.tiles.length, 1);
});

test("the options refuse a state colored twice and an out-of-range column count", () => {
  const bad = (options: Record<string, unknown>) =>
    Panel.safeParse({
      id: "g",
      title: "Hosts",
      viz: "status-grid",
      query: { sourceId: "s", sql: "SELECT 1" },
      options,
      layout: LAYOUT,
    }).success;
  assert.equal(
    bad({
      states: [
        { state: "ok", color: "success" },
        { state: "ok", color: "danger" },
      ],
    }),
    false,
  );
  assert.equal(bad({ columns: 0 }), false);
  assert.equal(bad({ columns: 13 }), false);
  assert.equal(bad({ color: "#ff0000" }), false);
  assert.equal(bad({ columns: 4, sort: "value" }), true);
});

test("each tile writes its label, value and state, so color is never the only signal", () => {
  const html = renderToStaticMarkup(
    <StatusGridView
      panel={grid({ thresholds: STEPS }, { format: "percent" })}
      data={SERIES}
    />,
  );
  assert.match(html, /aria-label="Hosts, status grid"/);
  assert.match(html, /<ul[^>]*>.*<li/);
  assert.match(html, /web-2/);
  assert.match(html, /web-10/);
  assert.match(html, /75/);
  // A tinted tile, and no text drawn in the tint's color.
  assert.match(html, /color-mix\(in srgb, #[0-9a-f]{6} 20%, var\(--surface-2\)\)/);
  assert.doesNotMatch(html, /[^-]color:\s*#/);
});

test("overflow says how many tiles were left out", () => {
  const rows = Array.from({ length: STATUS_GRID_MAX + 3 }, (_, i) => ({
    host: `h${i}`,
    cpu: i,
  }));
  const html = renderToStaticMarkup(
    <StatusGridView panel={grid()} data={{ columns: ["host", "cpu"], rows }} />,
  );
  assert.match(html, /3 more not shown/);
});
