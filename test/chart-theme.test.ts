import assert from "node:assert/strict";
import { test } from "node:test";
import type { PanelData } from "@/components/charts/options";
import type { ChartSize } from "@/components/charts/size";
import { PANEL_RENDERERS } from "@/components/panels/registry";
import {
  type ChartTheme,
  DEFAULT_CHART_THEME,
  forcedColorsTheme,
  inkOn,
  readChartTheme,
  soften,
} from "@/lib/color/chart-theme";
import { Panel } from "@/lib/ir";
import { readdirSync, readFileSync } from "node:fs";
import {
  AA_TEXT,
  contrastRatio,
  hexToRgb,
  parseThemeBlocks,
  parseThemeDecls,
  parseThemeTokens,
} from "@/lib/color/contrast";
import { resolveColor } from "@/lib/color/oklch";
import { COLOR_TOKENS, FILL_TOKENS } from "@/lib/panels/colors";
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
  for (const [token, variable] of Object.entries(FILL_TOKENS)) {
    assert.equal(d.fills[token as keyof typeof d.fills], hex(variable.slice(2)), token);
  }
  assert.equal(d.raised, hex("surface-3"));
});

test("the chart style's defaults are the tokens in globals.css", () => {
  // #647: the type scale, line width and fills are tokens a palette can set;
  // the defaults a server render draws with are the stylesheet's.
  const css = readFileSync("src/app/globals.css", "utf8");
  const value = (token: string) => {
    const m = new RegExp(`--${token}:\\s*([\\d.]+)(px)?;`).exec(css);
    assert.ok(m, `--${token}`);
    return Number(m[1]);
  };
  const d = DEFAULT_CHART_THEME;
  assert.deepEqual(d.type, {
    axis: value("chart-font-size-axis"),
    label: value("chart-font-size-label"),
    tooltip: value("chart-font-size-tooltip"),
    value: value("chart-font-size-value"),
  });
  assert.equal(d.lineWidth, value("chart-line-width"));
  assert.deepEqual(d.area, {
    fade: value("chart-area-fade"),
    flat: value("chart-area-flat"),
    stacked: value("chart-area-stacked"),
  });
  assert.equal(d.soften, value("chart-soften"));
  assert.equal(d.radius, value("radius"));
});

test("the chart style is read off the page like its colors", () => {
  const theme = readChartTheme(
    style({
      "--font-sans": ' "Chakra Petch", ui-sans-serif ',
      "--radius": "6px",
      "--chart-font-size-axis": "12px",
      "--chart-line-width": "1.5px",
      "--chart-area-stacked": "0.9",
      "--chart-soften": "0",
      "--chart-area-fade": "not a number",
    }),
  );
  assert.equal(theme.font, '"Chakra Petch", ui-sans-serif');
  assert.equal(theme.radius, 6);
  assert.equal(theme.type.axis, 12);
  assert.equal(theme.type.tooltip, DEFAULT_CHART_THEME.type.tooltip);
  assert.equal(theme.lineWidth, 1.5);
  assert.equal(theme.area.stacked, 0.9);
  assert.equal(
    theme.area.fade,
    DEFAULT_CHART_THEME.area.fade,
    "an unreadable value keeps its default",
  );
  assert.equal(theme.soften, 0);
  assert.equal(
    soften(theme, "#123456"),
    "#123456",
    "no softening leaves the color as it is",
  );
});

/** Nothing like any scheme's real colors, so a leak of a default is visible. */
const DISTINCT: ChartTheme = {
  text: "#010101",
  line: "#020202",
  grid: "#030303",
  track: "#060606",
  faint: 0.35,
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
  font: "Distinct Sans",
  radius: 6,
  raised: "#070707",
  type: { axis: 13, label: 14, tooltip: 15, value: 29 },
  lineWidth: 3,
  area: { fade: 0.4, flat: 0.2, stacked: 0.8 },
  soften: 0.2,
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
  fills: {
    success: "#404040",
    warning: "#515151",
    danger: "#424242",
    info: "#434343",
    neutral: "#444444",
    orange: "#555555",
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
  // The page's face and sizes carry over; nothing blends a system color into
  // another (#647), so a large area and a stacked band are the color itself.
  const page = forcedColorsTheme((k) => system[k], DISTINCT);
  assert.equal(page.font, DISTINCT.font);
  assert.deepEqual(page.type, DISTINCT.type);
  assert.equal(page.soften, 0);
  assert.equal(page.area.stacked, 1);
  assert.equal(page.radius, 0);
});

/** Every value under `key`, anywhere in an option. */
function collect(node: unknown, key: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) {
    for (const item of node) collect(item, key, out);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === key) out.push(v);
      collect(v, key, out);
    }
  }
  return out;
}

/** Each registered chart kind with rows it draws from, and the options it needs. */
const KIND_FIXTURES: Partial<
  Record<Panel["viz"], { data: PanelData; options?: object }>
> = {
  treemap: {
    data: {
      columns: ["region", "host", "used"],
      rows: [
        { region: "eu", host: "a", used: 4 },
        { region: "us", host: "b", used: 6 },
      ],
    },
    options: { path: ["region", "host"], value: "used" },
  },
  graph: {
    data: {
      columns: ["source", "target", "calls"],
      rows: [
        { source: "lb", target: "api", calls: 3 },
        { source: "api", target: "db", calls: 2 },
      ],
    },
    options: { source: "source", target: "target", value: "calls" },
  },
  sankey: {
    data: {
      columns: ["source", "target", "bytes"],
      rows: [
        { source: "lb", target: "api", bytes: 3 },
        { source: "api", target: "db", bytes: 2 },
      ],
    },
    options: { source: "source", target: "target", value: "bytes" },
  },
  "state-timeline": {
    data: {
      columns: ["ts", "service", "state"],
      rows: [
        { ts: "2026-10-11T10:00:00Z", service: "api", state: "up" },
        { ts: "2026-10-11T10:05:00Z", service: "api", state: "down" },
      ],
    },
  },
};

function drawnBy(
  viz: Panel["viz"],
  theme: ChartTheme,
  options?: object,
  size?: ChartSize,
): Record<string, unknown> {
  const renderer = PANEL_RENDERERS[viz];
  assert.equal(renderer.type, "chart", viz);
  if (renderer.type !== "chart") throw new Error(viz);
  const fixture = KIND_FIXTURES[viz];
  const parsed = Panel.safeParse({
    id: "p",
    title: "Requests",
    viz,
    query: { sourceId: "s", sql: "SELECT 1", timeField: "ts" },
    layout: { x: 0, y: 0, w: 6, h: 4 },
    ...(fixture?.options || options
      ? { options: { ...fixture?.options, ...options } }
      : {}),
  });
  assert.ok(parsed.success, `${viz}: ${JSON.stringify(parsed.error?.issues)}`);
  return renderer.option(parsed.data, fixture?.data ?? DATA, {
    display: LOCAL_TIME_DISPLAY,
    theme,
    window: {
      from: Date.parse("2026-10-11T10:00:00Z"),
      to: Date.parse("2026-10-11T10:10:00Z"),
    },
    size,
  }) as Record<string, unknown>;
}

/** The panel sizes #643 measured, as a chart inside its card is drawn. */
const SIZES: (ChartSize | undefined)[] = [
  undefined,
  { width: 140, height: 80 },
  { width: 200, height: 120 },
  { width: 280, height: 180 },
  { width: 400, height: 260 },
];

const CHART_KINDS = Object.entries(PANEL_RENDERERS).flatMap(([viz, renderer]) =>
  renderer.type === "chart" ? [viz as Panel["viz"]] : [],
);

test("every chart kind writes in the page's font, at the chart scale, with the shared tooltip", () => {
  // #647: one style for every kind. A kind's own text, wherever it sits,
  // is the page's face at a size from the type scale.
  const scale = new Set([...Object.values(DISTINCT.type), DISTINCT.type.label - 1]);
  const variants: [Panel["viz"], object?][] = [
    ...CHART_KINDS.map((viz): [Panel["viz"]] => [viz]),
    ["gauge", { variant: "bar" }],
    ["treemap", { variant: "sunburst" }],
    ["graph", { layout: "dag" }],
    ["graph", { layout: "force" }],
  ];
  for (const [[viz, options], size] of variants.flatMap((v) =>
    SIZES.map((size) => [v, size] as const),
  )) {
    const name = `${viz} ${JSON.stringify(options ?? {})} at ${JSON.stringify(size)}`;
    const option = drawnBy(viz, DISTINCT, options, size);
    assert.deepEqual(
      option.textStyle,
      { fontFamily: DISTINCT.font, fontSize: DISTINCT.type.axis },
      name,
    );
    const families = collect(option, "fontFamily");
    assert.deepEqual(
      families.filter((f) => f !== DISTINCT.font),
      [],
      `${name} writes in another face`,
    );
    // The one exception is the dial's value, which `gaugeScale` sizes to its
    // ring (#643), between the label size and twice the value size.
    const detail = collect(option, "detail");
    const values = collect(detail, "fontSize") as number[];
    for (const v of values) {
      assert.ok(
        Number.isInteger(v) && v >= DISTINCT.type.label && v <= DISTINCT.type.value * 2,
        `${name}: the value at ${v}`,
      );
    }
    const others = collect(
      {
        ...option,
        series: collect(option, "series")
          .flat()
          .map((s) => ({ ...(s as object), detail: undefined })),
      },
      "fontSize",
    );
    assert.deepEqual(
      others.filter((s) => !scale.has(s as number)),
      [],
      `${name} writes off the scale`,
    );
    const tooltip = option.tooltip as Record<string, unknown>;
    if (tooltip.show === false) continue;
    assert.equal(tooltip.backgroundColor, DISTINCT.raised, name);
    assert.equal(tooltip.borderRadius, DISTINCT.radius, name);
    assert.deepEqual(
      tooltip.textStyle,
      {
        fontFamily: DISTINCT.font,
        fontSize: DISTINCT.type.tooltip,
        color: DISTINCT.foreground,
      },
      name,
    );
  }
});

/**
 * Every leaf path in an option, with array items folded together: what a
 * merge would leave behind if one option set a field and the next did not.
 */
function fieldPaths(node: unknown, at = "", out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) fieldPaths(item, `${at}[]`, out);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) fieldPaths(v, `${at}.${k}`, out);
  } else {
    out.add(at);
  }
  return out;
}

test("a size step sets every field the last one did, so the merge never keeps a stale one", () => {
  // #643: a new size is merged into the same chart (invariant 11), and a
  // merge keeps a field the new option leaves out. So a kind that varies a
  // field by size sets it at every size (`show: false`, an empty name).
  const variants: [Panel["viz"], object?][] = [
    ...CHART_KINDS.map((viz): [Panel["viz"]] => [viz]),
    ["gauge", { variant: "bar" }],
    ["graph", { layout: "dag" }],
    ["graph", { layout: "force" }],
    ["line", { legend: "bottom" }],
    ["line", { legend: "right", yAxis: { label: "req/s" } }],
    ["line", { decimals: 0, unit: "req" }],
    ["histogram", { log: true }],
  ];
  for (const [viz, options] of variants) {
    const name = `${viz} ${JSON.stringify(options ?? {})}`;
    const [first, ...rest] = SIZES.map((size) =>
      [...fieldPaths(drawnBy(viz, DISTINCT, options, size))].sort(),
    );
    for (const [i, paths] of rest.entries()) {
      assert.deepEqual(paths, first, `${name} at ${JSON.stringify(SIZES[i + 1])}`);
    }
  }
});

test("only the shared chart style sets corners, faces and sizes", () => {
  // #647: a kind that sets its own `borderRadius`, `fontFamily` or `fontSize`
  // drifts from the rest; it takes them from `style.ts` instead.
  const files = [
    ...readdirSync("src/components/charts")
      .filter((f) => /\.tsx?$/.test(f) && f !== "style.ts")
      .map((f) => `src/components/charts/${f}`),
    "src/components/panels/vega.tsx",
  ];
  const own = /\b(borderRadius|fontFamily|fontSize)\s*:/;
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    const found = lines.flatMap((line, i) =>
      own.test(line) ? [`${file}:${i + 1}`] : [],
    );
    assert.deepEqual(found, [], "set through src/components/charts/style.ts");
  }
});

test("large areas are softened toward the surface; lines, bars and progress are not", () => {
  // #647: a block of saturated color shouts in a muted interface, so the
  // kinds that fill large areas pull their colors toward the surface; a thin
  // mark keeps the literal color. This is the list.
  const softened = (hex: string) => soften(DISTINCT, hex);
  const literal = new Set([...DISTINCT.series, ...Object.values(DISTINCT.tokens)]);
  const soft = new Set([...literal].map(softened));
  const fills = (option: Record<string, unknown>) =>
    (option.series as { data: { itemStyle?: { color?: string } }[] }[]).flatMap((s) =>
      s.data.flatMap((d) => (d.itemStyle?.color ? [d.itemStyle.color] : [])),
    );
  const allSoft = (colors: unknown[], name: string) => {
    assert.ok(colors.length > 0, name);
    for (const c of colors)
      assert.ok(soft.has(c as string), `${name}: ${c} is not softened`);
  };
  const allLiteral = (colors: unknown[], name: string) => {
    assert.ok(colors.length > 0, name);
    for (const c of colors)
      assert.ok(literal.has(c as string), `${name}: ${c} is not literal`);
  };

  // Softened: the large areas.
  for (const viz of ["pie", "donut"] as const) {
    assert.deepEqual(drawnBy(viz, DISTINCT).color, DISTINCT.series.map(softened), viz);
  }
  allSoft(fills(drawnBy("treemap", DISTINCT)), "treemap");
  allSoft(fills(drawnBy("treemap", DISTINCT, { variant: "sunburst" })), "sunburst");
  allSoft(fills(drawnBy("sankey", DISTINCT)), "sankey");
  allSoft(fills(drawnBy("state-timeline", DISTINCT)), "state-timeline");
  const stacked = drawnBy("area", DISTINCT, { stacked: true }).series as {
    areaStyle: { color: string; opacity: number };
    lineStyle: Record<string, unknown>;
    z: number;
  }[];
  allSoft(
    stacked.map((s) => s.areaStyle.color),
    "a stacked area",
  );

  // Literal: lines, bars, a histogram's bars and a gauge's progress.
  for (const viz of ["line", "bar", "area"] as const) {
    assert.deepEqual(drawnBy(viz, DISTINCT).color, [...DISTINCT.series], viz);
  }
  allLiteral(fills(drawnBy("histogram", DISTINCT)), "histogram");
  allLiteral(fills(drawnBy("gauge", DISTINCT, { variant: "bar" })), "bar gauge");
  const radial = drawnBy("gauge", DISTINCT).series as {
    progress: { itemStyle: { color: string } };
  }[];
  allLiteral([radial[0].progress.itemStyle.color], "radial gauge");
});

test("a share written on a slice reads on its softened fill, in every theme (AA)", () => {
  // #638: a large slice carries its share inside it, in `inkOn` of the
  // fill the slice is drawn in, which is the softened series color.
  for (const viz of ["pie", "donut"] as const) {
    const option = drawnBy(
      viz,
      DISTINCT,
      { legend: "bottom" },
      { width: 600, height: 400 },
    );
    const fills = option.color as string[];
    const [series] = option.series as {
      label: { position: string };
      data: { label: { show: boolean; color: string } }[];
    }[];
    assert.equal(series.label.position, "inside", viz);
    assert.ok(
      series.data.some((d) => d.label.show),
      `${viz}: a large slice carries its share`,
    );
    for (const [i, d] of series.data.entries()) {
      assert.equal(d.label.color, inkOn(fills[i % fills.length]), `${viz} slice ${i}`);
    }
  }
  // Every series color, softened as each theme softens it toward its own
  // surface, holds AA against the ink chosen for it.
  const css = readFileSync("src/app/globals.css", "utf8");
  const blocks = parseThemeBlocks(css);
  for (const { palette, scheme, decls } of parseThemeDecls(css)) {
    const tokens = blocks.find(
      (b) => b.palette === palette && b.scheme === scheme,
    )?.tokens;
    assert.ok(tokens?.surface, `${palette} ${scheme}: --surface`);
    const hex = (rgb: readonly number[]) =>
      `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
    const amount = Number(decls["--chart-soften"] ?? DEFAULT_CHART_THEME.soften);
    const theme = {
      ...DEFAULT_CHART_THEME,
      background: hex(tokens.surface),
      soften: amount,
    };
    for (let i = 1; i <= 8; i++) {
      const rgb = tokens[`chart-${i}`];
      assert.ok(rgb, `${palette} ${scheme}: --chart-${i}`);
      const fill = soften(theme, hex(rgb));
      const ratio = contrastRatio(hexToRgb(inkOn(fill)), hexToRgb(fill));
      assert.ok(
        ratio >= AA_TEXT,
        `${palette} ${scheme} chart-${i}: ${ratio.toFixed(2)}:1`,
      );
    }
  }
});

test("a stacked area draws near-solid bands parted by a line of surface; a lone one fades", () => {
  // #647: a band's thickness is its share, so it is near solid, and the thin
  // ones stay visible. Its 2px line is on top of it, with a 1px line of
  // surface above that parting it from the next band up; each lower band is
  // drawn after the one above, so the band above does not cover them.
  const stacked = drawnBy("area", DISTINCT, { stacked: true }).series as {
    areaStyle: { opacity: number };
    lineStyle: Record<string, unknown>;
    z: number;
  }[];
  assert.ok(stacked.length > 0);
  for (const [i, s] of stacked.entries()) {
    assert.equal(s.areaStyle.opacity, DISTINCT.area.stacked);
    assert.deepEqual(s.lineStyle, {
      width: DISTINCT.lineWidth,
      shadowColor: DISTINCT.background,
      shadowBlur: 0,
      shadowOffsetY: -1,
    });
    if (i > 0)
      assert.ok(s.z < stacked[i - 1].z, "a lower band is drawn over the one above");
  }
  const lone = drawnBy("area", DISTINCT).series as {
    areaStyle: { color: { colorStops: { color: string }[] } };
    lineStyle: Record<string, unknown>;
    z?: number;
  }[];
  for (const s of lone) {
    const [top, bottom] = s.areaStyle.color.colorStops.map((c) => c.color);
    assert.match(top, new RegExp(`, ${DISTINCT.area.fade}\\)$`));
    assert.match(bottom, /, 0\)$/);
    assert.deepEqual(s.lineStyle, { width: DISTINCT.lineWidth });
    assert.equal(s.z, undefined);
  }
});

test("a status drawn as a fill takes its fill token, and as text its text token", () => {
  // #641: an amber dark enough to be text on a light surface reads brown over
  // an arc or a bar, so a fill (held to 3:1) draws the brighter shade.
  const warn = { value: 0, color: "warning" };
  const gauge = JSON.stringify(drawnBy("gauge", DISTINCT, { thresholds: [warn] }));
  assert.ok(gauge.includes(DISTINCT.fills.warning), "the gauge's arc is the fill");
  assert.ok(!gauge.includes(DISTINCT.tokens.warning), "the gauge draws no warning text");
  const bars = JSON.stringify(
    drawnBy("gauge", DISTINCT, { thresholds: [warn], variant: "bar" }),
  );
  assert.ok(bars.includes(DISTINCT.fills.warning), "a gauge's bar is the fill");
  // A page that sets no fill fills in the token's own color.
  const theme = readChartTheme(style({ "--warning": "oklch(0.5 0.17 70)" }));
  assert.equal(theme.fills.warning, theme.tokens.warning);
  const split = readChartTheme(
    style({ "--warning": "oklch(0.5 0.17 70)", "--warning-fill": "oklch(0.66 0.15 75)" }),
  );
  assert.notEqual(split.fills.warning, split.tokens.warning);
});
