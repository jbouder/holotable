import assert from "node:assert/strict";
import { test } from "node:test";
import type { PanelData } from "@/components/charts/options";
import { PANEL_RENDERERS } from "@/components/panels/registry";
import {
  type ChartTheme,
  DEFAULT_CHART_THEME,
  forcedColorsTheme,
  readChartTheme,
} from "@/lib/color/chart-theme";
import type { Panel } from "@/lib/ir";
import { readFileSync } from "node:fs";
import { parseThemeTokens } from "@/lib/color/contrast";
import { resolveColor } from "@/lib/color/oklch";
import { COLOR_TOKENS } from "@/lib/panels/colors";
import { LOCAL_TIME_DISPLAY } from "@/lib/time-display";

/*
 * Charts follow the theme (#502): the axis text, lines and grid every chart
 * draws come from the page's tokens, read off `<html>`, never from a literal
 * that only suits one theme.
 */

/** A computed style that holds exactly these custom properties. */
function style(vars: Record<string, string>) {
  return { getPropertyValue: (name: string) => vars[name] ?? "" };
}

test("the chart theme is the page's tokens, converted for a canvas", () => {
  const theme = readChartTheme(
    style({
      "--chart-text": "oklch(0.5 0.02 265)",
      "--chart-axis": "oklch(0.84 0.02 265)",
      "--chart-grid": " oklch(0.94 0.01 265) ",
      "--foreground": "#202020",
      "--chart-1": "oklch(0.52 0.19 259)",
      "--success": "oklch(0.46 0.14 160)",
    }),
  );
  const values = [
    theme.text,
    theme.line,
    theme.grid,
    theme.foreground,
    theme.background,
    ...theme.series,
    ...theme.sequential,
    ...theme.diverging,
    ...Object.values(theme.tokens),
  ];
  for (const value of values) assert.match(value, /^#[0-9a-f]{6}$/);
  // The light scheme's chart text is darker than the dark scheme's.
  assert.notEqual(theme.text, DEFAULT_CHART_THEME.text);
  assert.notEqual(theme.series[0], DEFAULT_CHART_THEME.series[0]);
  assert.notEqual(theme.tokens.success, DEFAULT_CHART_THEME.tokens.success);
  assert.equal(
    theme.series[1],
    DEFAULT_CHART_THEME.series[1],
    "an unset token keeps its default",
  );
  assert.equal(theme.foreground, "#202020");
});

test("a token the page does not set keeps the dark theme's value", () => {
  assert.deepEqual(readChartTheme(style({})), DEFAULT_CHART_THEME);
});

test("the defaults are the dark scheme's tokens in globals.css", () => {
  // #502: a server render and a test draw what the dark page would.
  const dark = parseThemeTokens(readFileSync("src/app/globals.css", "utf8")).dark;
  const hex = (token: string) => {
    const rgb = dark[token];
    assert.ok(rgb, `--${token}`);
    return `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  };
  const d = DEFAULT_CHART_THEME;
  assert.equal(d.text, hex("chart-text"));
  assert.equal(d.line, hex("chart-axis"));
  assert.equal(d.grid, hex("chart-grid"));
  assert.equal(d.track, hex("chart-track"));
  assert.equal(d.foreground, hex("foreground"));
  assert.equal(d.background, hex("surface"));
  assert.deepEqual(
    d.series,
    d.series.map((_, i) => hex(`chart-${i + 1}`)),
  );
  assert.deepEqual(
    d.sequential,
    d.sequential.map((_, i) => hex(`chart-seq-${i + 1}`)),
  );
  assert.deepEqual(d.diverging, [
    hex("chart-div-low"),
    hex("chart-div-mid"),
    hex("chart-div-high"),
  ]);
  for (const [token, variable] of Object.entries(COLOR_TOKENS)) {
    assert.equal(d.tokens[token as keyof typeof d.tokens], hex(variable.slice(2)), token);
  }
});

/** Nothing like any scheme's real colors, so a leak of a default is visible. */
const DISTINCT: ChartTheme = {
  text: "#010101",
  line: "#020202",
  grid: "#030303",
  track: "#060606",
  foreground: "#040404",
  background: "#050505",
  series: [
    "#101010",
    "#111111",
    "#121212",
    "#131313",
    "#141414",
    "#151515",
    "#161616",
    "#171717",
  ],
  sequential: ["#202020", "#212121", "#222222", "#232323", "#242424"],
  diverging: ["#303030", "#313131", "#323232"],
  tokens: {
    success: "#404040",
    warning: "#414141",
    danger: "#424242",
    info: "#434343",
    neutral: "#444444",
    orange: "#454545",
    purple: "#464646",
    teal: "#474747",
  },
};

const DARK_LITERALS = [
  DEFAULT_CHART_THEME.text,
  DEFAULT_CHART_THEME.line,
  DEFAULT_CHART_THEME.grid,
  DEFAULT_CHART_THEME.foreground,
  ...DEFAULT_CHART_THEME.series,
  ...DEFAULT_CHART_THEME.sequential,
  ...Object.values(DEFAULT_CHART_THEME.tokens),
];

const DATA: PanelData = {
  columns: ["ts", "host", "v"],
  rows: [
    { ts: "2026-10-11T10:00:00Z", host: "a", v: 1 },
    { ts: "2026-10-11T10:01:00Z", host: "b", v: 2 },
  ],
};

test("every chart kind draws all its colors from the theme it is given", () => {
  const charts = Object.entries(PANEL_RENDERERS).flatMap(([viz, renderer]) =>
    renderer.type === "chart"
      ? [{ viz: viz as Panel["viz"], option: renderer.option }]
      : [],
  );
  assert.ok(charts.length > 0);
  for (const { viz, option } of charts) {
    const panel: Panel = {
      id: "p",
      title: "Requests",
      viz,
      query: { sourceId: "s", sql: "SELECT 1", timeField: "ts" },
      layout: { x: 0, y: 0, w: 6, h: 4 },
    };
    const drawn = JSON.stringify(
      option(panel, DATA, { display: LOCAL_TIME_DISPLAY, theme: DISTINCT }),
    );
    for (const literal of DARK_LITERALS) {
      assert.ok(!drawn.includes(literal), `${viz} still draws ${literal}`);
    }
  }
});

test("a token served as lab(), as a production build serves it, reads as hex", () => {
  // #502: the build's CSS pipeline rewrites oklch() tokens into lab(), and a
  // computed style hands that back; a blend or a contrast check needs hex.
  assert.equal(resolveColor("lab(100% 0 0)"), "#ffffff");
  assert.equal(resolveColor("lab(0% 0 0)"), "#000000");
  // The CSS Color 4 example: lab(54.29% 80.82 69.88) is sRGB red.
  assert.equal(resolveColor("lab(54.29% 80.82 69.88)"), "#ff0000");
  assert.equal(resolveColor("rgb(255, 128, 0)"), "#ff8000");
  assert.equal(resolveColor(" #ABCDEF "), "#abcdef");
  const theme = readChartTheme(style({ "--chart-seq-1": "lab(92.02% -8.2 -11.6)" }));
  assert.match(theme.sequential[0], /^#[0-9a-f]{6}$/);
});

test("under forced colors a chart draws only in system colors", () => {
  // #506: a canvas is not recolored by the system, so the chart draws in
  // the system's own colors, text and lines in CanvasText on Canvas.
  const system: Record<string, string> = {
    CanvasText: "#fffff0",
    Canvas: "#000010",
    GrayText: "#808081",
    Highlight: "#00ff01",
    LinkText: "#ffff02",
    VisitedText: "#00ff03",
  };
  const theme = forcedColorsTheme((k) => system[k] ?? assert.fail(`asked for ${k}`));
  const allowed = new Set(Object.values(system));
  const every = [
    theme.text,
    theme.line,
    theme.grid,
    theme.foreground,
    theme.background,
    ...theme.series,
    ...theme.sequential,
    ...theme.diverging,
    ...Object.values(theme.tokens),
  ];
  assert.deepEqual(
    every.filter((c) => !allowed.has(c)),
    [],
  );
  assert.equal(theme.text, system.CanvasText);
  assert.equal(theme.background, system.Canvas);
  // Adjacent series differ, so neighbors stay apart.
  for (let i = 1; i < theme.series.length; i++) {
    assert.notEqual(theme.series[i], theme.series[i - 1]);
  }
});
