import { resolveColor } from "@/lib/color/oklch";

/**
 * The page around a chart's series, as colors ECharts can paint (#502).
 *
 * A canvas cannot read a CSS variable, so the axis text, lines and grid every
 * chart draws are read off `<html>`'s computed style and converted, the way a
 * Vega panel already does it. Series colors are the palette in `oklch.ts`;
 * these are the tokens the page itself uses, so a chart's chrome is the same
 * gray as the text and borders beside it in either theme.
 */
export interface ChartTheme {
  /** Axis labels, legend entries, pie labels, a chart's own small titles: `--muted`. */
  text: string;
  /** Axis lines and pie label lines: `--border`. */
  line: string;
  /** Grid lines, a gauge's track, a bar's background: `--surface-2`, quieter than a border. */
  grid: string;
  /** The one value a gauge writes large: `--foreground`. */
  foreground: string;
}

const TOKENS: Record<keyof ChartTheme, string> = {
  text: "--muted",
  line: "--border",
  grid: "--surface-2",
  foreground: "--foreground",
};

/**
 * The dark theme's values, for a server render and a test, which have no page
 * to read: the hex every chart was drawn with before it followed the theme. A
 * page replaces all four before a chart's first option is built.
 */
export const DEFAULT_CHART_THEME: ChartTheme = {
  text: "#9aa0aa",
  line: "#3a3f4b",
  grid: "#2a2f3a",
  foreground: "#e6e8ee",
};

/** The tokens as a computed style has them; one that is unset keeps its default. */
export function readChartTheme(
  style: Pick<CSSStyleDeclaration, "getPropertyValue">,
): ChartTheme {
  const token = (key: keyof ChartTheme) => {
    const value = style.getPropertyValue(TOKENS[key]).trim();
    return value ? resolveColor(value) : DEFAULT_CHART_THEME[key];
  };
  return {
    text: token("text"),
    line: token("line"),
    grid: token("grid"),
    foreground: token("foreground"),
  };
}
