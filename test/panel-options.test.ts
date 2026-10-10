import { test } from "node:test";
import assert from "node:assert/strict";
import type { z } from "zod";
import {
  barChart,
  lineChart,
  optionsShape,
  type PanelData,
  pieChart,
} from "@/components/charts/options";
import { formatValue } from "@/lib/format";
import { Panel } from "@/lib/ir";
import { statReading, TABLE_ROWS_MAX, tableView } from "@/lib/panel-reading";
import { withOptions } from "@/lib/panel-options";
import { COLOR_TOKENS, tokenHex } from "@/lib/panels/colors";
import { PRESENTATION_GUIDE } from "@/lib/ai/generate";
import { OPTION_GROUPS } from "@/lib/panels/presentation";
import { PANEL_KINDS } from "@/lib/panels/registry";
import { LOCAL_TIME_DISPLAY } from "@/lib/time-display";

/** Panel presentation options (#115). */

const LAYOUT = { x: 0, y: 0, w: 6, h: 4 };
const ctx = { display: LOCAL_TIME_DISPLAY };

function panel(viz: string, options?: unknown, extra: Record<string, unknown> = {}) {
  return {
    id: "p",
    title: "P",
    viz,
    query: { sourceId: "s", sql: "SELECT 1", timeField: "ts" },
    ...(options === undefined ? {} : { options }),
    layout: LAYOUT,
    ...extra,
  };
}

function issues(input: unknown): string[] {
  const parsed = Panel.safeParse(input);
  return parsed.success
    ? []
    : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

const parse = (input: unknown) => Panel.parse(input);

const series: PanelData = {
  columns: ["ts", "a", "b"],
  rows: [
    { ts: "2026-10-04T10:00:00Z", a: 1, b: 10 },
    { ts: "2026-10-04T10:01:00Z", a: 2, b: 20 },
  ],
};

test("each option group is validated by the IR, and a malformed one refused", () => {
  assert.deepEqual(
    issues(
      panel("line", {
        decimals: 2,
        unit: "req/s",
        compact: true,
        legend: "right",
        yAxis: { min: 0, max: 100, label: "Requests" },
        stacked: true,
        thresholds: [
          { value: 0, color: "success" },
          { value: 80, color: "danger" },
        ],
      }),
    ),
    [],
  );
  const refused: [string, unknown, RegExp][] = [
    ["line", { decimals: 7 }, /decimals/],
    ["line", { decimals: 1.5 }, /decimals/],
    ["line", { unit: "a unit far too long" }, /unit/],
    ["line", { legend: "left" }, /legend/],
    ["line", { yAxis: { min: 10, max: 10 } }, /min must be below max/],
    ["line", { yAxis: { log: true, min: 0 } }, /log axis/],
    ["line", { yAxis: { colour: "red" } }, /yAxis/],
    ["line", { thresholds: [{ value: 0, color: "#ff0000" }] }, /thresholds/],
    ["stat", { sparkline: "yes" }, /sparkline/],
    ["stat", { legend: "top" }, /legend/],
    ["table", { columns: [{ name: "a" }, { name: "a" }] }, /listed twice/],
    ["table", { columns: [{ name: "a", width: 5 }] }, /width/],
    ["table", { sort: { column: "a", order: "up" } }, /order/],
    ["pie", { stacked: true }, /stacked/],
  ];
  for (const [viz, options, message] of refused) {
    assert.match(
      issues(panel(viz, options)).join("\n"),
      message,
      JSON.stringify(options),
    );
  }
});

test("every group a kind lists is fields of that kind's options", () => {
  for (const kind of PANEL_KINDS) {
    if (!kind.optionGroups) continue;
    assert.ok(kind.options, `${kind.kind} lists groups but takes no options`);
    const shape = (kind.options as unknown as z.ZodObject).shape;
    for (const group of kind.optionGroups) {
      for (const field of OPTION_GROUPS[group]) {
        assert.ok(field in shape, `${kind.kind}: group "${group}" field "${field}"`);
      }
    }
  }
});

test("a panel without options draws exactly as before", () => {
  const p = parse(panel("line"));
  const option = lineChart(p, series, ctx) as Record<string, unknown>;
  assert.deepEqual(option.legend, { top: 0, textStyle: { color: "#9aa0aa" } });
  assert.deepEqual(option.grid, { left: 44, right: 16, top: 24, bottom: 28 });
  assert.deepEqual(option.tooltip, { trigger: "axis", borderRadius: 0 });
  assert.equal(option.visualMap, undefined);
  assert.deepEqual(option.yAxis, {
    type: "value",
    axisLabel: { color: "#9aa0aa" },
    splitLine: { lineStyle: { color: "#2a2f3a" } },
  });
  for (const s of option.series as Record<string, unknown>[]) {
    assert.equal("stack" in s, false);
  }

  const stat = parse({ ...panel("stat"), format: "percent" });
  assert.equal(
    statReading(stat, { columns: ["v"], rows: [{ v: 12.3456 }] }).text,
    formatValue(12.3456, "percent"),
  );
  const rows = Array.from({ length: 150 }, (_, i) => ({ a: i, b: `x${i}` }));
  const table = tableView(parse(panel("table")), { columns: ["a", "b"], rows });
  assert.deepEqual(
    table.columns.map((c) => [c.name, c.label]),
    [
      ["a", "a"],
      ["b", "b"],
    ],
  );
  assert.equal(table.rows.length, TABLE_ROWS_MAX);
  assert.equal(table.rows[0].a, 50, "the newest rows, as before");
  assert.equal(table.columns[0].text(1234.5678), "1234.5678", "cells as returned");
});

test("number options write values on stats, axes and tooltips", () => {
  assert.equal(
    formatValue(1234.5, undefined, { decimals: 2 }),
    (1234.5).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }),
  );
  assert.equal(formatValue(12, undefined, { unit: "hosts" }), "12 hosts");
  assert.equal(formatValue(2048, "bytes", { unit: "/s", decimals: 1 }), "2.0 KB/s");
  assert.equal(formatValue(42.123, "percent", { decimals: 0 }), "42%");
  assert.match(formatValue(1_500_000, undefined, { compact: true }), /^1\.5\s?M$/);
  assert.equal(formatValue("n/a", "number", { unit: "x" }), "n/a", "not a number");

  const p = parse(panel("line", { decimals: 1, unit: "ms" }));
  const option = lineChart(p, series, ctx) as {
    tooltip: { valueFormatter: (v: unknown) => string };
    yAxis: { axisLabel: { formatter: (v: unknown) => string } };
  };
  assert.equal(option.tooltip.valueFormatter(3), "3.0 ms");
  assert.equal(option.yAxis.axisLabel.formatter(3), "3.0 ms");
});

test("axis, legend and stacking options reach the chart", () => {
  const p = parse(
    panel("bar", {
      legend: "right",
      yAxis: { min: 1, max: 1000, log: true, label: "Latency" },
      stacked: true,
    }),
  );
  const option = barChart(p, series, ctx) as Record<string, Record<string, unknown>>;
  assert.equal(option.yAxis.type, "log");
  assert.equal(option.yAxis.min, 1);
  assert.equal(option.yAxis.max, 1000);
  assert.equal(option.yAxis.name, "Latency");
  assert.equal(option.legend.orient, "vertical");
  assert.equal((option.grid as { right: number }).right, 128);
  for (const s of option.series as unknown as Record<string, unknown>[]) {
    assert.equal(s.stack, "total");
  }

  const hidden = barChart(parse(panel("bar", { legend: "none" })), series, ctx);
  assert.deepEqual(hidden.legend, { show: false });
  const pie = pieChart(parse(panel("pie", { legend: "bottom" })), series, ctx);
  assert.equal((pie.legend as { bottom: number }).bottom, 0);
});

test("thresholds color series and stats through the tokens (invariant 13)", () => {
  const thresholds = [
    { value: 0, color: "success" },
    { value: 50, color: "warning" },
    { value: 90, color: "danger" },
  ];
  const option = lineChart(parse(panel("line", { thresholds })), series, ctx) as {
    visualMap: { show: boolean; pieces: Record<string, unknown>[] };
  };
  assert.equal(option.visualMap.show, false);
  assert.deepEqual(option.visualMap.pieces.slice(1), [
    { gte: 0, lt: 50, color: tokenHex("success") },
    { gte: 50, lt: 90, color: tokenHex("warning") },
    { gte: 90, color: tokenHex("danger") },
  ]);
  assert.deepEqual(Object.keys(option.visualMap.pieces[0]), ["lt", "color"]);

  const stat = parse(panel("stat", { thresholds }));
  assert.equal(statReading(stat, { columns: ["v"], rows: [{ v: 95 }] }).color, "danger");
  assert.equal(statReading(stat, { columns: ["v"], rows: [{ v: 60 }] }).color, "warning");
  assert.equal(statReading(stat, { columns: ["v"], rows: [{ v: -1 }] }).color, undefined);
});

test("a stat names its value column instead of the heuristic, and can draw a sparkline", () => {
  const data: PanelData = {
    columns: ["errors", "requests"],
    rows: [
      { errors: 1, requests: 100 },
      { errors: 3, requests: 120 },
    ],
  };
  const heuristic = statReading(parse(panel("stat")), data);
  assert.equal(heuristic.column, "errors");
  const named = statReading(parse(panel("stat", { value: "requests" })), data);
  assert.equal(named.column, "requests");
  assert.equal(named.text, "120");
  assert.deepEqual(named.spark, [], "no sparkline unless asked");
  assert.deepEqual(
    statReading(parse(panel("stat", { value: "requests", sparkline: true })), data).spark,
    [100, 120],
  );
  // A named column the result lacks falls back rather than showing nothing.
  assert.equal(
    statReading(parse(panel("stat", { value: "gone" })), data).column,
    "errors",
  );
});

test("table columns can be formatted, relabeled, reordered, hidden and sorted", () => {
  const data: PanelData = {
    columns: ["host", "bytes", "region", "secret"],
    rows: [
      { host: "b", bytes: 2048, region: "eu", secret: 1 },
      { host: "a", bytes: 4096, region: "us", secret: 2 },
      { host: "c", bytes: null, region: "eu", secret: 3 },
    ],
  };
  const view = tableView(
    parse(
      panel("table", {
        columns: [
          {
            name: "bytes",
            label: "Traffic",
            format: "bytes",
            align: "right",
            width: 120,
          },
          { name: "missing" },
          { name: "secret", hidden: true },
        ],
        sort: { column: "bytes", order: "desc" },
      }),
    ),
    data,
  );
  assert.deepEqual(
    view.columns.map((c) => c.name),
    ["bytes", "host", "region"],
  );
  const traffic = view.columns[0];
  assert.equal(traffic.label, "Traffic");
  assert.equal(traffic.align, "right");
  assert.equal(traffic.width, 120);
  assert.equal(traffic.text(2048), "2 KB");
  assert.equal(traffic.text(null), "", "an empty cell stays empty");
  assert.deepEqual(
    view.rows.map((r) => r.host),
    ["a", "b", "c"],
    "descending, empty last",
  );
});

test("the editor's option edits merge, clear, and refuse what the kind would", () => {
  const p = parse(panel("line", { decimals: 1 }));
  const added = withOptions(p, { unit: "ms" });
  assert.ok(added.ok);
  assert.deepEqual(added.panel.options, { decimals: 1, unit: "ms" });

  const cleared = withOptions(p, { decimals: undefined });
  assert.ok(cleared.ok);
  assert.equal("options" in cleared.panel, false, "no options left is no options");

  const refused = withOptions(p, { yAxis: { min: 5, max: 1 } });
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.error, /yAxis\.max: min must be below max/);

  const heatmap = parse({
    ...panel("heatmap"),
    query: { sourceId: "s", sql: "SELECT 1" },
  });
  assert.equal(withOptions(heatmap, { legend: "top" }).ok, false);
});

test("a chart is drawn anew when its options change, and merged when only data does", () => {
  const a = parse(panel("line", { stacked: true }));
  const b = parse(panel("line", { stacked: true, legend: "none" }));
  assert.notEqual(optionsShape(a), optionsShape(b));
  assert.equal(optionsShape(a), optionsShape(parse(panel("line", { stacked: true }))));
});

test("the model is told every shared option and every color token", () => {
  for (const fields of Object.values(OPTION_GROUPS)) {
    for (const field of fields) assert.ok(PRESENTATION_GUIDE.includes(field), field);
  }
  for (const token of Object.keys(COLOR_TOKENS)) {
    assert.ok(PRESENTATION_GUIDE.includes(token), token);
  }
});

test("a stat's number takes the theme's status token, so it reads in both themes", async () => {
  const { tokenTextColor } = await import("@/lib/panels/colors");
  // The semantic three, and info and neutral, have a theme token held to AA
  // by CONTRAST_PAIRS; a palette-only color gives none and the text stays
  // the foreground.
  assert.equal(tokenTextColor("warning"), "var(--warning)");
  assert.equal(tokenTextColor("danger"), "var(--danger)");
  assert.equal(tokenTextColor("success"), "var(--success)");
  assert.equal(tokenTextColor("info"), "var(--primary)");
  assert.equal(tokenTextColor("neutral"), "var(--muted)");
  assert.equal(tokenTextColor("orange"), undefined);
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { StatView } = await import("@/components/panels/stat");
  const stat = Panel.parse({
    id: "s",
    title: "Error rate",
    viz: "stat",
    query: { sourceId: "s", sql: "SELECT 1" },
    options: {
      thresholds: [
        { value: 0, color: "success" },
        { value: 1, color: "warning" },
      ],
    },
    layout: { x: 0, y: 0, w: 3, h: 2 },
  });
  const html = renderToStaticMarkup(
    createElement(StatView, { panel: stat, data: { columns: ["v"], rows: [{ v: 3 }] } }),
  );
  assert.match(html, /color:var\(--warning\)/);
});
