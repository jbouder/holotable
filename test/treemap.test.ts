import assert from "node:assert/strict";
import { test } from "node:test";
import type { PanelData } from "@/components/charts/options";
import {
  TREEMAP_LEAVES_MAX,
  treemapChart,
  treemapNodes,
  treemapLabel,
  treemapShape,
  treemapTree,
} from "@/components/charts/treemap";
import { AA_TEXT, contrastRatio, hexToRgb } from "@/lib/color/contrast";
import { chartPalette } from "@/lib/color/oklch";
import { Panel } from "@/lib/ir";
import { LOCAL_TIME_DISPLAY } from "@/lib/time-display";

/*
 * The treemap (#404): rows as leaves at the end of their path, parents as the
 * sum of their children, every node colored by its top-level branch.
 */

const LAYOUT = { x: 0, y: 0, w: 6, h: 4 };
const CTX = { display: LOCAL_TIME_DISPLAY };

function treemap(options: Record<string, unknown> = {}): Panel {
  return Panel.parse({
    id: "t",
    title: "Disk",
    viz: "treemap",
    query: { sourceId: "s", sql: "SELECT 1" },
    options,
    layout: LAYOUT,
  });
}

const DISK: PanelData = {
  columns: ["region", "host", "used"],
  rows: [
    { region: "eu", host: "a", used: 10 },
    { region: "us", host: "c", used: 30 },
    { region: "eu", host: "b", used: 5 },
    { region: "eu", host: "a", used: 2 },
  ],
};

test("rows are leaves on their path, summed; parents are the sum of their children", () => {
  const tree = treemapTree(treemap(), DISK);
  assert.deepEqual(tree.pathKeys, ["region", "host"]);
  assert.equal(tree.valueKey, "used");
  assert.deepEqual(
    tree.roots.map((r) => [r.name, r.value, r.children.map((c) => [c.name, c.value])]),
    [
      ["us", 30, [["c", 30]]],
      [
        "eu",
        17,
        [
          ["a", 12],
          ["b", 5],
        ],
      ],
    ],
  );
  const a = treemapNodes(tree).find((n) => n.name === "a");
  assert.deepEqual(a?.path, { region: "eu", host: "a" });
});

test("a named path picks and orders the levels", () => {
  const tree = treemapTree(treemap({ path: ["host"], value: "used" }), DISK);
  assert.deepEqual(
    tree.roots.map((r) => [r.name, r.value]),
    [
      ["c", 30],
      ["a", 12],
      ["b", 5],
    ],
  );
});

test("zero, negative and missing values are not drawn", () => {
  const tree = treemapTree(treemap(), {
    columns: ["k", "v"],
    rows: [
      { k: "a", v: 0 },
      { k: "b", v: -3 },
      { k: "c", v: null },
      { k: "d", v: 4 },
    ],
  });
  assert.deepEqual(
    tree.roots.map((r) => r.name),
    ["d"],
  );
});

test("past the cap, the smallest leaves are left out and counted", () => {
  const rows = Array.from({ length: TREEMAP_LEAVES_MAX + 3 }, (_, i) => ({
    k: `n${i}`,
    v: i + 1,
  }));
  const tree = treemapTree(treemap(), { columns: ["k", "v"], rows });
  assert.equal(tree.roots.length, TREEMAP_LEAVES_MAX);
  assert.equal(tree.overflow, 3);
  assert.equal(
    tree.roots.some((r) => r.name === "n0"),
    false,
  );
});

test("each branch takes one chart color, and its labels read on it", () => {
  const option = treemapChart(treemap(), DISK, CTX);
  const series = (
    option.series as { type: string; data: Record<string, unknown>[] }[]
  )[0];
  assert.equal(series?.type, "treemap");
  const eu = series?.data.find((d) => d.name === "eu") as {
    id: string;
    itemStyle: { color: string };
    children: { id: string; itemStyle: { color: string } }[];
  };
  assert.equal(eu.id, "eu");
  assert.equal(eu.children[0]?.id, "eu\u001fa");
  for (const child of eu.children)
    assert.equal(child.itemStyle.color, eu.itemStyle.color);
  // The palette is one set in both themes; each color's label meets AA on it.
  for (const color of chartPalette()) {
    const ratio = contrastRatio(hexToRgb(treemapLabel(color)), hexToRgb(color));
    assert.ok(ratio >= AA_TEXT, `${color}: ${ratio.toFixed(2)}:1`);
  }
  const label = (eu as unknown as { label: { color: string } }).label.color;
  assert.equal(label, treemapLabel(eu.itemStyle.color));
});

test("the sunburst variant draws rings, and a click never zooms", () => {
  const option = treemapChart(treemap({ variant: "sunburst" }), DISK, CTX);
  const series = (option.series as { type: string; nodeClick: unknown }[])[0];
  assert.equal(series?.type, "sunburst");
  assert.equal(series?.nodeClick, false);
  const flat = treemapChart(treemap(), DISK, CTX);
  assert.equal((flat.series as { nodeClick: unknown }[])[0]?.nodeClick, false);
});

test("a variant change remounts; a data update merges", () => {
  assert.equal(treemapShape(treemap()), treemapShape(treemap()));
  assert.notEqual(
    treemapShape(treemap()),
    treemapShape(treemap({ variant: "sunburst" })),
  );
});

test("no rows, no text column or no number draw an empty chart rather than throwing", () => {
  assert.deepEqual(treemapTree(treemap(), { columns: [], rows: [] }).roots, []);
  assert.deepEqual(
    treemapTree(treemap(), { columns: ["v"], rows: [{ v: 3 }] }).roots,
    [],
  );
  assert.doesNotThrow(() =>
    treemapChart(treemap(), { columns: ["x"], rows: [{ x: {} }] }, CTX),
  );
});

test("the options refuse a path deeper than five and an unknown variant", () => {
  const ok = (options: Record<string, unknown>) =>
    Panel.safeParse({
      id: "t",
      title: "Disk",
      viz: "treemap",
      query: { sourceId: "s", sql: "SELECT 1" },
      options,
      layout: LAYOUT,
    }).success;
  assert.equal(ok({ path: ["a", "b"], value: "v", variant: "sunburst" }), true);
  assert.equal(ok({ path: ["a", "b", "c", "d", "e", "f"] }), false);
  assert.equal(ok({ variant: "icicle" }), false);
  assert.equal(ok({ path: [] }), false);
});
