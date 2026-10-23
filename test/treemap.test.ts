import assert from "node:assert/strict";
import { test } from "node:test";
import type { PanelData } from "@/components/charts/options";
import {
  TREEMAP_LEAVES_MAX,
  treemapChart,
  treemapFills,
  treemapNodes,
  treemapLabel,
  treemapShape,
  treemapTree,
} from "@/components/charts/treemap";
import {
  AA_TEXT,
  contrastRatio,
  hexToRgb,
  parseThemeDecls,
  resolveBlock,
} from "@/lib/color/contrast";
import { treemapCells } from "@/components/charts/treemap-layout";
import { rankShades } from "@/lib/color/shade";
import { readFileSync } from "node:fs";
import { Panel } from "@/lib/ir";
import { DEFAULT_CHART_THEME, soften } from "@/lib/color/chart-theme";
import { LOCAL_TIME_DISPLAY } from "@/lib/time-display";

/*
 * The treemap (#404): rows as leaves at the end of their path, parents as the
 * sum of their children; regions as containers, their members shaded by rank
 * from the branch's color, labels that carry the value (#657).
 */

const LAYOUT = { x: 0, y: 0, w: 6, h: 4 };
const CTX = { display: LOCAL_TIME_DISPLAY, theme: DEFAULT_CHART_THEME };

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

type Item = {
  id: string;
  name: string;
  itemStyle: { color: string };
  label?: { color: string; formatter: () => string };
  upperLabel?: { formatter: () => string };
  emphasis?: { itemStyle: Record<string, unknown> };
  children?: Item[];
};
const seriesOf = (option: ReturnType<typeof treemapChart>) =>
  (option.series as { type: string; data: Item[]; emphasis: unknown }[])[0];

test("regions are containers with a header; their hosts are shaded steps of the branch color", () => {
  // #657: a region is drawn on the raised surface with its name and total;
  // the branch color moves to its members, a step apart by rank.
  const series = seriesOf(treemapChart(treemap(), DISK, CTX));
  assert.equal(series?.type, "treemap");
  const eu = series?.data.find((d) => d.name === "eu") as Item;
  assert.equal(eu.id, "eu");
  assert.equal(eu.itemStyle.color, DEFAULT_CHART_THEME.container);
  assert.equal(eu.upperLabel?.formatter(), "eu  {t|17}");
  const hosts = eu.children ?? [];
  assert.equal(hosts[0]?.id, "eu\u001fa");
  const branch = soften(DEFAULT_CHART_THEME, DEFAULT_CHART_THEME.series[1]);
  assert.deepEqual(
    hosts.map((h) => h.itemStyle.color),
    rankShades(branch, 2, DEFAULT_CHART_THEME.container),
  );
  assert.notEqual(hosts[0]?.itemStyle.color, hosts[1]?.itemStyle.color);
  // Top left, its name and under it its value and its share of the region.
  assert.equal(hosts[0]?.label?.formatter(), "a\n{v|12 · 71%}");
  for (const h of hosts) {
    assert.equal(h.label?.color, treemapLabel(h.itemStyle.color));
    // Under the pointer, an outline in the ring color around the fill as it
    // is, not one ECharts lightens under the label.
    assert.equal(h.emphasis?.itemStyle.strokeColor, DEFAULT_CHART_THEME.ring);
    assert.equal(h.emphasis?.itemStyle.color, h.itemStyle.color);
  }
});

test("every shade, of every series color, in every palette and scheme, is its own and its label clears AA", () => {
  // #657: siblings never share a fill, however many there are, and a label
  // on any step meets AA.
  const hex = (rgb: readonly number[]) =>
    `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  const aa = (fill: string, where: string) => {
    const ratio = contrastRatio(hexToRgb(treemapLabel(fill)), hexToRgb(fill));
    assert.ok(ratio >= AA_TEXT, `${where}: ${ratio.toFixed(2)}:1 on ${fill}`);
  };
  const blocks = parseThemeDecls(readFileSync("src/app/globals.css", "utf8"));
  assert.ok(blocks.length >= 10);
  for (const { palette, scheme, decls } of blocks) {
    const { tokens } = resolveBlock(decls);
    const theme = {
      ...DEFAULT_CHART_THEME,
      background: hex(tokens.surface),
      container: hex(tokens["surface-2"]),
      soften: Number(decls["chart-soften"] ?? DEFAULT_CHART_THEME.soften),
      series: Array.from({ length: 8 }, (_, i) => hex(tokens[`chart-${i + 1}`])),
    };
    for (const [i, color] of theme.series.entries()) {
      const branch = soften(theme, color);
      for (const toward of [theme.container, theme.background]) {
        for (const count of [1, 2, 3, 5, 8, 13, 40]) {
          const where = `${palette} ${scheme} chart-${i + 1}, ${count} members`;
          const shades = rankShades(branch, count, toward);
          assert.equal(new Set(shades).size, count, `${where} share a fill`);
          assert.equal(shades[0], branch, where);
          for (const fill of shades) aa(fill, where);
        }
      }
    }
  }
  // And as the chart draws them: every fill of a deep tree is its own among
  // its siblings.
  const rows = Array.from({ length: 30 }, (_, i) => ({
    region: `r${i % 3}`,
    host: `h${i}`,
    used: 100 - i,
  }));
  for (const variant of ["treemap", "sunburst"] as const) {
    const tree = treemapTree(treemap(), { columns: ["region", "host", "used"], rows });
    const fills = treemapFills(tree, DEFAULT_CHART_THEME, variant);
    for (const root of tree.roots) {
      const own = root.children.map((c) => fills.get(c.id));
      assert.equal(new Set(own).size, own.length, variant);
    }
  }
});

test("a label that does not fit its block is left out whole, never cut", () => {
  // #657: whether a label fits is worked out from where ECharts will draw the
  // block; one that does not is empty (the tooltip and the table carry it).
  const rows = Array.from({ length: 12 }, (_, i) => ({
    region: i < 6 ? "us-east" : "eu-west",
    host: `host-${String(i).padStart(2, "0")}`,
    used: 2 ** (12 - i),
  }));
  const data = { columns: ["region", "host", "used"], rows };
  const labels = (size?: { width: number; height: number }) =>
    (seriesOf(treemapChart(treemap(), data, { ...CTX, size }))?.data ?? []).flatMap((r) =>
      (r.children ?? []).map((h) => [h.name, h.label?.formatter() ?? ""] as const),
    );
  const full = labels();
  assert.ok(full.every(([name, text]) => text.startsWith(`${name}\n{v|`)));
  for (const size of [
    { width: 600, height: 300 },
    { width: 240, height: 160 },
    { width: 100, height: 60 },
  ]) {
    const drawn = labels(size);
    for (const [name, text] of drawn) {
      assert.ok(text === "" || text.startsWith(`${name}\n{v|`), `${name}: ${text}`);
      assert.ok(!text.includes("…"));
    }
    const shown = drawn.filter(([, t]) => t !== "").length;
    if (size.width === 600) assert.ok(shown >= 3, `${shown} labels at 600`);
    if (size.width === 100) assert.ok(shown <= 2, `${shown} labels at 100`);
  }
  // The cells are ECharts' own: one level, no gaps, fills the box exactly.
  const cells = treemapCells(
    [
      { id: "a", value: 6, children: [] },
      { id: "b", value: 3, children: [] },
      { id: "c", value: 1, children: [] },
    ],
    200,
    100,
    { rootGap: 0, border: 0, gap: 0, header: 0 },
  );
  const area = [...cells.values()].reduce((s, c) => s + c.width * c.height, 0);
  assert.ok(Math.abs(area - 20000) < 1e-6);
  assert.ok(
    Math.abs((cells.get("a")?.width ?? 0) * (cells.get("a")?.height ?? 0) - 12000) < 1e-6,
  );
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
