import { contrastRatio, hexToRgb } from "@/lib/color/contrast";
import { oklchToHex, resolveColor } from "@/lib/color/oklch";
import { COLOR_TOKENS, type ColorToken, FILL_TOKENS } from "@/lib/panels/colors";

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
  /**
   * How strongly a mark behind a value is drawn, 0 to 1: a gauge's threshold
   * bands, a stat's sparkline. `--chart-faint`; high contrast draws them
   * stronger (#549).
   */
  faint: number;
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
  /** Each spec color token (`success`, `teal`, …), as the page paints it as text. */
  tokens: Readonly<Record<ColorToken, string>>;
  /**
   * Each token as a fill (#641): `FILL_TOKENS`, a brighter amber than the
   * text one in a light scheme, the token itself everywhere else.
   */
  fills: Readonly<Record<ColorToken, string>>;
  /**
   * The page's type: `--font-sans`, so a canvas writes in the same face the
   * page beside it is set in. A canvas cannot inherit a font any more than a
   * color (#647).
   */
  font: string;
  /** The page's corner radius in CSS pixels: `--radius`. Bars, tooltips and labels take it. */
  radius: number;
  /** A tooltip sits on this, a step above the surface: `--surface-3`. */
  raised: string;
  /** The chart type scale in CSS pixels: `--chart-font-size-*`. */
  type: Readonly<ChartTypeScale>;
  /** Every series line's width in CSS pixels: `--chart-line-width`. */
  lineWidth: number;
  /** How opaque an area is drawn, 0 to 1: `--chart-area-*`. */
  area: Readonly<ChartAreaFill>;
  /**
   * How far a large area's color is pulled toward the surface, 0 to 1:
   * `--chart-soften`. See {@link soften}.
   */
  soften: number;
}

/** The sizes a chart writes in. */
export interface ChartTypeScale {
  /** Axis labels, legend entries, pie labels, a corner note. */
  axis: number;
  /** A label on a node, a block or a span. */
  label: number;
  /** A tooltip's body. */
  tooltip: number;
  /** The one number a gauge writes large. */
  value: number;
}

/** An area's opacities. */
export interface ChartAreaFill {
  /** An unstacked area at its line, fading to nothing at the axis. */
  fade: number;
  /** An unstacked area whose color a threshold map owns, which cannot fade. */
  flat: number;
  /** A stacked band: near solid, since its thickness is the data. */
  stacked: number;
}

export const SERIES_COUNT = 8;
const SEQUENTIAL_COUNT = 5;

/** What a chart writes in when the page has not said: the page's own stack, less the loaded face. */
export const DEFAULT_CHART_FONT =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

/**
 * The dark scheme's values, for a server render and a test, which have no
 * page to read. `test/chart-theme.test.ts` holds them to `globals.css`, so
 * they cannot drift from the tokens. A page replaces them before a chart's
 * first option is built.
 */
const DEFAULT_TOKENS: Readonly<Record<ColorToken, string>> = {
  success: oklchToHex({ l: 0.8, c: 0.12, h: 160 }),
  warning: oklchToHex({ l: 0.82, c: 0.13, h: 82 }),
  danger: oklchToHex({ l: 0.74, c: 0.15, h: 22 }),
  info: oklchToHex({ l: 0.72, c: 0.13, h: 250 }),
  neutral: oklchToHex({ l: 0.72, c: 0.015, h: 260 }),
  orange: oklchToHex({ l: 0.8, c: 0.13, h: 80 }),
  purple: oklchToHex({ l: 0.77, c: 0.11, h: 310 }),
  teal: oklchToHex({ l: 0.78, c: 0.09, h: 210 }),
};

export const DEFAULT_CHART_THEME: ChartTheme = {
  text: oklchToHex({ l: 0.72, c: 0.015, h: 260 }),
  line: oklchToHex({ l: 0.33, c: 0.012, h: 260 }),
  grid: oklchToHex({ l: 0.225, c: 0.012, h: 260 }),
  track: oklchToHex({ l: 0.24, c: 0.012, h: 260 }),
  faint: 0.35,
  foreground: oklchToHex({ l: 0.95, c: 0.008, h: 260 }),
  background: oklchToHex({ l: 0.195, c: 0.012, h: 260 }),
  series: [
    { l: 0.68, c: 0.13, h: 250 },
    { l: 0.72, c: 0.12, h: 160 },
    { l: 0.8, c: 0.13, h: 80 },
    { l: 0.72, c: 0.15, h: 25 },
    { l: 0.77, c: 0.11, h: 310 },
    { l: 0.78, c: 0.09, h: 210 },
    { l: 0.7, c: 0.15, h: 345 },
    { l: 0.87, c: 0.05, h: 95 },
  ].map(oklchToHex),
  sequential: [
    { l: 0.3, c: 0.05, h: 250 },
    { l: 0.43, c: 0.09, h: 250 },
    { l: 0.56, c: 0.12, h: 250 },
    { l: 0.69, c: 0.12, h: 240 },
    { l: 0.83, c: 0.08, h: 220 },
  ].map(oklchToHex),
  diverging: [
    oklchToHex({ l: 0.68, c: 0.13, h: 250 }),
    oklchToHex({ l: 0.33, c: 0.012, h: 260 }),
    oklchToHex({ l: 0.72, c: 0.15, h: 25 }),
  ],
  font: DEFAULT_CHART_FONT,
  radius: 6,
  raised: oklchToHex({ l: 0.29, c: 0.012, h: 260 }),
  type: { axis: 11, label: 11, tooltip: 12, value: 24 },
  lineWidth: 2,
  area: { fade: 0.32, flat: 0.18, stacked: 0.85 },
  soften: 0.2,
  tokens: DEFAULT_TOKENS,
  // In dark every fill is its token.
  fills: DEFAULT_TOKENS,
};

/** The tokens as a computed style has them; one that is unset keeps its default. */
export function readChartTheme(
  style: Pick<CSSStyleDeclaration, "getPropertyValue">,
): ChartTheme {
  const read = (name: string, fallback: string) => {
    const value = style.getPropertyValue(name).trim();
    return value ? resolveColor(value) : fallback;
  };
  const px = (name: string, fallback: number) =>
    readPx(style.getPropertyValue(name), fallback);
  const fraction = (name: string, fallback: number) =>
    readFraction(style.getPropertyValue(name), fallback);
  const d = DEFAULT_CHART_THEME;
  const tokens = Object.fromEntries(
    (Object.keys(COLOR_TOKENS) as ColorToken[]).map((t) => [
      t,
      read(COLOR_TOKENS[t], d.tokens[t]),
    ]),
  ) as Record<ColorToken, string>;
  // A page that sets no fill fills in the token's own color.
  const fills = Object.fromEntries(
    (Object.keys(FILL_TOKENS) as ColorToken[]).map((t) => [
      t,
      read(FILL_TOKENS[t], tokens[t]),
    ]),
  ) as Record<ColorToken, string>;
  return {
    text: read("--chart-text", d.text),
    line: read("--chart-axis", d.line),
    grid: read("--chart-grid", d.grid),
    track: read("--chart-track", d.track),
    faint: fraction("--chart-faint", d.faint),
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
    fills,
    font: readFont(style.getPropertyValue("--font-sans"), d.font),
    radius: px("--radius", d.radius),
    raised: read("--surface-3", d.raised),
    type: {
      axis: px("--chart-font-size-axis", d.type.axis),
      label: px("--chart-font-size-label", d.type.label),
      tooltip: px("--chart-font-size-tooltip", d.type.tooltip),
      value: px("--chart-font-size-value", d.type.value),
    },
    lineWidth: px("--chart-line-width", d.lineWidth),
    area: {
      fade: fraction("--chart-area-fade", d.area.fade),
      flat: fraction("--chart-area-flat", d.area.flat),
      stacked: fraction("--chart-area-stacked", d.area.stacked),
    },
    soften: fraction("--chart-soften", d.soften),
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
 * that with a probe element. `page` is the theme the page would draw, for
 * what is not a color: its font, type scale and line width carry over; its
 * corners and softening do not, so every fill is exactly a system color.
 */
export function forcedColorsTheme(
  system: (keyword: string) => string,
  page: ChartTheme = DEFAULT_CHART_THEME,
): ChartTheme {
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
    // The bands stay faint: in forced colors every token is the same ink.
    faint: 0.35,
    foreground: text,
    background: system("Canvas"),
    series: [highlight, link, text, visited, gray, highlight, link, text],
    sequential: [gray, gray, link, highlight, text],
    diverging: [link, gray, highlight],
    tokens,
    fills: tokens,
    font: page.font,
    radius: 0,
    raised: system("Canvas"),
    type: page.type,
    lineWidth: page.lineWidth,
    // A stacked band is solid: a system color at an alpha is not one.
    area: { ...page.area, stacked: 1 },
    soften: 0,
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

/**
 * A color as a large area wears it (#647): a treemap node, a pie slice, a
 * sankey node, a timeline span, a stacked band. A line can be saturated
 * because it is thin; the same color over a whole block shouts, so a block
 * takes the color pulled `theme.soften` of the way (a fifth, by default)
 * toward the surface it sits on. A label on it goes through `inkOn` of the
 * softened fill. Lines, bars and a gauge's progress keep the literal color.
 */
export function soften(theme: ChartTheme, hex: string): string {
  return theme.soften > 0 ? blend(hex, theme.background, theme.soften) : hex;
}

/** `hex` mixed with `toward` by `amount` (0 keeps `hex`), in sRGB, as a hex. */
export function blend(hex: string, toward: string, amount: number): string {
  const a = hexToRgb(hex);
  const b = hexToRgb(toward);
  const mix = (i: number) => Math.round(a[i] * (1 - amount) + b[i] * amount);
  return `#${[0, 1, 2].map((i) => mix(i).toString(16).padStart(2, "0")).join("")}`;
}

/** A font-family list from a custom property, or `fallback` when it is empty. */
function readFont(value: string, fallback: string): string {
  const font = value.trim();
  return font ? font : fallback;
}

/** A pixel length from a custom property (`6px`, `0`), or `fallback` when it is not one. */
function readPx(value: string, fallback: number): number {
  const m = /^\s*(\d+(?:\.\d+)?)(px)?\s*$/.exec(value);
  if (!m) return fallback;
  const n = Number.parseFloat(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** A 0–1 number from a custom property, or `fallback` when it is not one. */
function readFraction(value: string, fallback: number): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}
