import assert from "node:assert/strict";
import { test } from "node:test";
import type { PanelData } from "@/components/charts/options";
import { PANEL_RENDERERS } from "@/components/panels/registry";
import {
  type ChartTheme,
  DEFAULT_CHART_THEME,
  readChartTheme,
} from "@/lib/color/chart-theme";
import type { Panel } from "@/lib/ir";
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
      "--muted": "oklch(0.5 0.02 265)",
      "--border": "oklch(0.84 0.02 265)",
      "--surface-2": " oklch(0.94 0.01 265) ",
      "--foreground": "#202020",
    }),
  );
  for (const value of Object.values(theme)) assert.match(value, /^#[0-9a-f]{6}$/);
  // The light theme's muted text is darker than the dark theme's.
  assert.notEqual(theme.text, DEFAULT_CHART_THEME.text);
  assert.equal(theme.foreground, "#202020");
});

test("a token the page does not set keeps the dark theme's value", () => {
  assert.deepEqual(readChartTheme(style({})), DEFAULT_CHART_THEME);
});

/** Nothing like any theme's real colors, so a leak of either is visible. */
const DISTINCT: ChartTheme = {
  text: "#010101",
  line: "#020202",
  grid: "#030303",
  foreground: "#040404",
};

const DARK_LITERALS = Object.values(DEFAULT_CHART_THEME);

const DATA: PanelData = {
  columns: ["ts", "host", "v"],
  rows: [
    { ts: "2026-10-11T10:00:00Z", host: "a", v: 1 },
    { ts: "2026-10-11T10:01:00Z", host: "b", v: 2 },
  ],
};

test("every chart kind draws its chrome with the theme it is given", () => {
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
