/**
 * The node symbols a graph panel may draw (#623).
 *
 * A spec names a symbol; it never carries one. ECharts takes a `path://` or
 * an `image://` string as a symbol, and an `image://` from a spec would have
 * the browser fetch a URL the model wrote, so this list is the allowlist:
 * ECharts' own shapes by name, and Holotable's network-diagram icons, each a
 * single SVG path on a 24-unit square drawn as a `path://` symbol. A path is
 * filled by the node's `itemStyle`, so an icon takes its color from the chart
 * palette like any other mark.
 *
 * Holes (a server's lights, a switch's ports) are subpaths wound the other
 * way, which the default nonzero fill leaves empty.
 */

/** ECharts' built-in shapes, drawn as they are named. */
export const BUILTIN_SYMBOLS = [
  "circle",
  "rect",
  "roundRect",
  "triangle",
  "diamond",
  "pin",
  "arrow",
] as const;

/** Holotable's network-diagram icons, by name. */
export const ICON_PATHS = {
  server:
    "M3 3h18v8H3z M6 6v2h2V6z M10 6v2h2V6z M3 13h18v8H3z M6 16v2h2v-2z M10 16v2h2v-2z",
  database:
    "M12 2C7 2 4 3.3 4 5v14c0 1.7 3 3 8 3s8-1.3 8-3V5c0-1.7-3-3-8-3z M18 7.6c-1.3 1-3.6 1.6-6 1.6s-4.7-.6-6-1.6v1.6c1.3 1 3.6 1.6 6 1.6s4.7-.6 6-1.6z",
  cloud: "M6.5 19a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 17.6 8.1A4.5 4.5 0 0 1 18 19z",
  router:
    "M6 3h2v9H6z M16 3h2v9h-2z M3 12h18v8H3z M6 15v2h2v-2z M10 15v2h2v-2z M14 15v2h4v-2z",
  switch: "M2 7h20v10H2z M5 11v2h2v-2z M9 11v2h2v-2z M13 11v2h2v-2z M17 11v2h2v-2z",
  firewall:
    "M2 4h20v16H2z M2 8.5v1.5h20V8.5z M2 14v1.5h20V14z M11.25 4v4.5h1.5V4z M6.25 10v4h1.5v-4z M16.25 10v4h1.5v-4z M11.25 15.5V20h1.5v-4.5z",
  loadBalancer:
    "M9 2h6v5H9z M11 7h2v3h-2z M4 10h16v2H4z M4 12h2v3H4z M11 12h2v3h-2z M18 12h2v3h-2z M2 15h6v5H2z M9 15h6v5H9z M16 15h6v5h-6z",
  queue: "M2 6h5v12H2z M9.5 6h5v12h-5z M17 6h5v12h-5z",
  cache: "M13 2L4 14h7l-1 8l9-12h-7z",
  storage: "M2 6h20v12H2z M5 11v2h8v-2z M17 11v2h2v-2z",
  user: "M12 2a5 5 0 1 0 0 10a5 5 0 1 0 0-10z M3 22c0-5 4-8 9-8s9 3 9 8z",
  service: "M12 2l8.66 5v10L12 22l-8.66-5V7z",
} as const satisfies Record<string, string>;

export type IconName = keyof typeof ICON_PATHS;

/** Every symbol a spec may name: the built-ins, then the icons. */
export const GRAPH_SYMBOLS = [
  ...BUILTIN_SYMBOLS,
  ...(Object.keys(ICON_PATHS) as IconName[]),
] as [GraphSymbol, ...GraphSymbol[]];
export type GraphSymbol = (typeof BUILTIN_SYMBOLS)[number] | IconName;

/** The size a built-in shape is drawn at when the spec gives none. */
export const SHAPE_SIZE = 10;
/** The size an icon is drawn at when the spec gives none: big enough to read. */
export const ICON_SIZE = 24;
/** The bounds of `symbolSize`. */
export const SYMBOL_SIZE_MIN = 6;
export const SYMBOL_SIZE_MAX = 48;

export function isIcon(symbol: GraphSymbol): symbol is IconName {
  return Object.hasOwn(ICON_PATHS, symbol);
}

/** The symbol as ECharts takes it: a built-in's name, or an icon's `path://`. */
export function echartsSymbol(symbol: GraphSymbol): string {
  return isIcon(symbol) ? `path://${ICON_PATHS[symbol]}` : symbol;
}

/** The size a symbol is drawn at: the spec's, else the one that suits its kind. */
export function symbolSizeFor(symbol: GraphSymbol, size: number | undefined): number {
  return size ?? (isIcon(symbol) ? ICON_SIZE : SHAPE_SIZE);
}
