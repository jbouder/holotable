import { contrastRatio, hexToRgb } from "@/lib/color/contrast";
import { oklchToHex, resolveColor } from "@/lib/color/oklch";
import { COLOR_TOKENS, type ColorToken } from "@/lib/panels/colors";

/**
 * A chart's colors, as ECharts and Vega can paint them (#502).
 *
 * A canvas cannot read a CSS variable, so every color a chart draws is a
 * token in `globals.css`, read off `<html>`'s computed style and converted,
 * per scheme: the series, the sequential ramp and the diverging pair, the
 * chrome (axis text, lines, grid), and the spec's color tokens. A chart is
 * then the same colors as the page beside it, in either scheme.
 */
export interface ChartTheme {
  /** Axis labels, legend entries, pie labels, a chart's own small titles: `--chart-text`. */
  text: string;
  /** Axis lines and pie label lines: `--chart-axis`. */
  line: string;
  /** Grid lines: `--chart-grid`. */
  grid: string;
  /**
   * A gauge's track and a bar's background, under a label: `--chart-track`.
   * Its own token, because high contrast makes the grid visible (#506) and a
   * label must still read on the track.
   */
  track: string;
  /** The one value a gauge writes large: `--foreground`. */
  foreground: string;
  /** What a chart sits on, for an exported image: `--surface`. */
  background: string;
  /** The categorical series, in order: `--chart-1` … `--chart-8`. */
  series: readonly string[];
  /** Low to high: `--chart-seq-1` … `--chart-seq-5`. */
  sequential: readonly string[];
  /** Low, middle and high of a diverging scale: `--chart-div-*`. */
  diverging: readonly [string, string, string];
  /** Each spec color token (`success`, `teal`, …), as the page paints it. */
  tokens: Readonly<Record<ColorToken, string>>;
}

export const SERIES_COUNT = 8;
const SEQUENTIAL_COUNT = 5;

/**
 * The dark scheme's values, for a server render and a test, which have no
 * page to read. `test/chart-theme.test.ts` holds them to `globals.css`, so
 * they cannot drift from the tokens. A page replaces them before a chart's
 * first option is built.
 */
export const DEFAULT_CHART_THEME: ChartTheme = {
  text: oklchToHex({ l: 0.7, c: 0.02, h: 265 }),
  line: oklchToHex({ l: 0.35, c: 0.02, h: 265 }),
  grid: oklchToHex({ l: 0.26, c: 0.02, h: 265 }),
  track: oklchToHex({ l: 0.26, c: 0.02, h: 265 }),
  foreground: oklchToHex({ l: 0.96, c: 0.01, h: 265 }),
  background: oklchToHex({ l: 0.21, c: 0.02, h: 265 }),
  series: [
    { l: 0.66, c: 0.19, h: 259 },
    { l: 0.7, c: 0.16, h: 160 },
    { l: 0.74, c: 0.17, h: 70 },
    { l: 0.68, c: 0.21, h: 20 },
    { l: 0.66, c: 0.2, h: 300 },
    { l: 0.72, c: 0.13, h: 195 },
    { l: 0.66, c: 0.2, h: 340 },
    { l: 0.9, c: 0.05, h: 330 },
  ].map(oklchToHex),
  sequential: [
    { l: 0.32, c: 0.06, h: 259 },
    { l: 0.45, c: 0.11, h: 259 },
    { l: 0.58, c: 0.16, h: 259 },
    { l: 0.7, c: 0.14, h: 240 },
    { l: 0.84, c: 0.09, h: 220 },
  ].map(oklchToHex),
  diverging: [
    oklchToHex({ l: 0.66, c: 0.17, h: 250 }),
    oklchToHex({ l: 0.36, c: 0.02, h: 265 }),
    oklchToHex({ l: 0.68, c: 0.21, h: 20 }),
  ],
  tokens: {
    success: oklchToHex({ l: 0.78, c: 0.16, h: 160 }),
    warning: oklchToHex({ l: 0.78, c: 0.16, h: 75 }),
    danger: oklchToHex({ l: 0.72, c: 0.19, h: 20 }),
    info: oklchToHex({ l: 0.66, c: 0.19, h: 259 }),
    neutral: oklchToHex({ l: 0.7, c: 0.02, h: 265 }),
    orange: oklchToHex({ l: 0.74, c: 0.17, h: 70 }),
    purple: oklchToHex({ l: 0.66, c: 0.2, h: 300 }),
    teal: oklchToHex({ l: 0.72, c: 0.13, h: 195 }),
  },
};

/** The tokens as a computed style has them; one that is unset keeps its default. */
export function readChartTheme(
  style: Pick<CSSStyleDeclaration, "getPropertyValue">,
): ChartTheme {
  const read = (name: string, fallback: string) => {
    const value = style.getPropertyValue(name).trim();
    return value ? resolveColor(value) : fallback;
  };
  const d = DEFAULT_CHART_THEME;
  const tokens = Object.fromEntries(
    (Object.keys(COLOR_TOKENS) as ColorToken[]).map((t) => [
      t,
      read(COLOR_TOKENS[t], d.tokens[t]),
    ]),
  ) as Record<ColorToken, string>;
  return {
    text: read("--chart-text", d.text),
    line: read("--chart-axis", d.line),
    grid: read("--chart-grid", d.grid),
    track: read("--chart-track", d.track),
    foreground: read("--foreground", d.foreground),
    background: read("--surface", d.background),
    series: Array.from({ length: SERIES_COUNT }, (_, i) =>
      read(`--chart-${i + 1}`, d.series[i]),
    ),
    sequential: Array.from({ length: SEQUENTIAL_COUNT }, (_, i) =>
      read(`--chart-seq-${i + 1}`, d.sequential[i]),
    ),
    diverging: [
      read("--chart-div-low", d.diverging[0]),
      read("--chart-div-mid", d.diverging[1]),
      read("--chart-div-high", d.diverging[2]),
    ],
    tokens,
  };
}

/** The media query for the operating system's forced colors (Windows High Contrast). */
export const FORCED_COLORS_QUERY = "(forced-colors: active)";

/**
 * A chart's colors when the operating system forces its own (#506).
 *
 * Forced colors replace every CSS color with a system one but cannot reach
 * into a canvas, so a chart drawn in the page's tokens can vanish into the
 * system background. The chart's container opts out of the adjustment
 * (`forced-color-adjust: none` in `globals.css`) and draws in the system
 * colors instead: `CanvasText` for text and lines, `Canvas` behind, and the
 * few other system colors for series. They are not many, so series lean on
 * order and the "Patterns in charts" setting more than on hue.
 *
 * `system` resolves a system color keyword to a hex string; the hook does
 * that with a probe element.
 */
export function forcedColorsTheme(system: (keyword: string) => string): ChartTheme {
  const text = system("CanvasText");
  const gray = system("GrayText");
  const highlight = system("Highlight");
  const link = system("LinkText");
  const visited = system("VisitedText");
  const tokens = Object.fromEntries(
    (Object.keys(COLOR_TOKENS) as ColorToken[]).map((t) => [
      t,
      t === "neutral" ? gray : text,
    ]),
  ) as Record<ColorToken, string>;
  return {
    text,
    line: text,
    grid: gray,
    track: system("Canvas"),
    foreground: text,
    background: system("Canvas"),
    series: [highlight, link, text, visited, gray, highlight, link, text],
    sequential: [gray, gray, link, highlight, text],
    diverging: [link, gray, highlight],
    tokens,
  };
}

/** The `n`th series color, cycling past the eighth. */
export function seriesColor(theme: ChartTheme, n: number): string {
  const count = theme.series.length;
  return theme.series[((n % count) + count) % count];
}

/** A hex color at an opacity, as ECharts takes it. */
export function withAlpha(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** The two inks a label inside a colored block may take. */
export const INK = { dark: "#000000", light: "#ffffff" } as const;

/** Whichever ink reads better on `fill`: a treemap node's label, a timeline span's. */
export function inkOn(fill: string): string {
  const on = hexToRgb(fill);
  return contrastRatio(hexToRgb(INK.dark), on) >= contrastRatio(hexToRgb(INK.light), on)
    ? INK.dark
    : INK.light;
}

/** A block's edge, drawn over any fill: black at a third. */
export const BLOCK_EDGE = withAlpha(INK.dark, 0.35);
