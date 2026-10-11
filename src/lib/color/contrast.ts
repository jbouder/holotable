import { resolveOklchToken } from "@/lib/color/oklch";
import { COLOR_TOKENS, type ColorToken } from "@/lib/panels/colors";

/**
 * WCAG contrast for the design tokens (#77).
 *
 * The tokens in `src/app/globals.css` are authored in OKLCH; this resolves
 * them to the sRGB the browser paints, composites the translucent tints
 * (`bg-success/20` is the token at 20% over whatever is behind it) the way the
 * browser does, and measures the WCAG 2.x contrast ratio of each text and
 * background pairing the interface actually uses. `test/contrast.test.ts`
 * holds every pairing to AA in both themes, so a token tweak that breaks one
 * fails CI rather than a reader.
 */

export type Rgb = readonly [number, number, number];

export const THEMES = ["dark", "light"] as const;
export type ThemeName = (typeof THEMES)[number];

export function hexToRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG 2.x relative luminance of a gamma-encoded sRGB color. */
export function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `top` at `alpha` over an opaque `bottom`, as the browser composites it. */
export function over(top: Rgb, alpha: number, bottom: Rgb): Rgb {
  return [0, 1, 2].map((i) => Math.round(top[i] * alpha + bottom[i] * (1 - alpha))) as [
    number,
    number,
    number,
  ];
}

/** One block of tokens: a palette (#503) in one scheme. */
export interface ThemeBlock {
  palette: string;
  scheme: ThemeName;
  tokens: Record<string, Rgb>;
}

/** A block's custom properties, as written. */
function blockDecls(css: string, at: number): Record<string, string> {
  const body = css.slice(at, css.indexOf("}", at));
  const out: Record<string, string> = {};
  for (const decl of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    out[decl[1]] = decl[2].trim();
  }
  return out;
}

/**
 * Declarations resolved to sRGB. An alias (`--chart-text: var(--muted)`)
 * resolves against the merged set, as the cascade does on the element that
 * carries both attributes: a palette that sets `--muted` but not
 * `--chart-text` gets its own muted.
 */
function resolveDecls(decls: Record<string, string>): Record<string, Rgb> {
  const out: Record<string, Rgb> = {};
  for (const [name, value] of Object.entries(decls)) {
    if (!value.startsWith("oklch(")) continue;
    const hex = resolveOklchToken(value);
    if (hex) out[name] = hexToRgb(hex);
  }
  for (const [name, value] of Object.entries(decls)) {
    const alias = /^var\(--([a-z0-9-]+)\)$/.exec(value);
    const target = alias && out[alias[1]];
    if (target) out[name] = target;
  }
  return out;
}

/**
 * Every theme block in `globals.css`, resolved to sRGB. Holotable is the two
 * unqualified blocks (`:root, [data-theme="dark"]` and `[data-theme="light"]`);
 * any other palette is `[data-palette="<name>"][data-theme="dark|light"]`.
 */
export function parseThemeBlocks(css: string): ThemeBlock[] {
  const at = (selector: RegExp): number => {
    const m = selector.exec(css);
    if (!m) throw new Error(`no theme block matching ${selector}`);
    return m.index + m[0].length;
  };
  const base: Record<ThemeName, Record<string, string>> = {
    dark: blockDecls(css, at(/:root,\s*\[data-theme="dark"\]\s*\{/)),
    light: blockDecls(css, at(/(?:^|\n)\[data-theme="light"\]\s*\{/)),
  };
  const blocks: ThemeBlock[] = [
    { palette: "holotable", scheme: "dark", tokens: resolveDecls(base.dark) },
    { palette: "holotable", scheme: "light", tokens: resolveDecls(base.light) },
  ];
  for (const m of css.matchAll(
    /\[data-palette="([a-z0-9-]+)"\]\[data-theme="(dark|light)"\]\s*\{/g,
  )) {
    const scheme = m[2] as ThemeName;
    blocks.push({
      palette: m[1],
      scheme,
      // On top of Holotable's block for the same scheme, as the cascade puts it.
      tokens: resolveDecls({
        ...base[scheme],
        ...blockDecls(css, (m.index ?? 0) + m[0].length),
      }),
    });
  }
  return blocks;
}

/** Holotable's two blocks, by scheme. */
export function parseThemeTokens(css: string): Record<ThemeName, Record<string, Rgb>> {
  const blocks = parseThemeBlocks(css).filter((b) => b.palette === "holotable");
  const of = (scheme: ThemeName) => blocks.find((b) => b.scheme === scheme)?.tokens ?? {};
  return { dark: of("dark"), light: of("light") };
}

/** One way the interface puts text on a background. */
export interface ContrastPair {
  text: string;
  /** The background token, opaque. */
  on: string;
  /** A tint of `tint` at this opacity over `on`, as `bg-<tint>/<n>` draws it. */
  tint?: { token: string; alpha: number };
  /**
   * The ratio required, when it is not AA for text: a chart series is a
   * graphic, held to the 3:1 of WCAG 1.4.11 (#502).
   */
  floor?: number;
  /** Where it is used, so a failure says what to look at. */
  where: string;
}

/** WCAG 2.1 non-text contrast (1.4.11): a series line, bar or slice. */
export const GRAPHIC = 3;

/**
 * What text sits on. `surface-3` is not here: it is only ever a hover fill
 * behind `text-foreground` (menu triggers, card actions), listed on its own.
 */
const SURFACES = ["background", "surface", "surface-2"] as const;
const STATUS = ["danger", "warning", "success"] as const;

/**
 * How much of its color a status-grid tile mixes into `surface-2` (#404). All
 * of a tile's text is `foreground`: `muted` falls below AA under some tints.
 */
export const STATUS_TILE_TINT = 0.2;

/**
 * The pairings in use. Text tokens on every surface; each status color on its
 * own tint, which is how badges, alerts and notices are drawn; the primary
 * button's label on its fill.
 */
export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  ...(["foreground", "muted", "primary", ...STATUS] as const).flatMap((text) =>
    SURFACES.map((on) => ({ text, on, where: `text-${text} on bg-${on}` })),
  ),
  { text: "foreground", on: "surface-3", where: "text-foreground on hover:bg-surface-3" },
  ...STATUS.flatMap((status) =>
    [0.05, 0.1, 0.15, 0.2].map((alpha) => ({
      text: status,
      on: "surface",
      tint: { token: status, alpha },
      where: `text-${status} on bg-${status}/${alpha * 100} (badges, alerts)`,
    })),
  ),
  {
    text: "primary",
    on: "surface",
    tint: { token: "primary", alpha: 0.1 },
    where: "text-primary on bg-primary/10",
  },
  ...(Object.keys(COLOR_TOKENS) as ColorToken[]).map((color) => ({
    text: "foreground",
    on: "surface-2",
    tint: { token: COLOR_TOKENS[color].slice(2), alpha: STATUS_TILE_TINT },
    where: `text-foreground on a ${color} status tile`,
  })),
  // A spec color as text (a stat's number, #502), on every surface.
  ...(Object.keys(COLOR_TOKENS) as ColorToken[]).flatMap((color) =>
    SURFACES.map((on) => ({
      text: COLOR_TOKENS[color].slice(2),
      on,
      where: `${color} as text on bg-${on}`,
    })),
  ),
  // The chart's own (#502): its text at AA, each series as a graphic at 3:1.
  ...SURFACES.map((on) => ({ text: "chart-text", on, where: `chart text on bg-${on}` })),
  ...Array.from({ length: 8 }, (_, i) => ({
    text: `chart-${i + 1}`,
    on: "surface",
    floor: GRAPHIC,
    where: `chart series ${i + 1} on bg-surface`,
  })),
  { text: "primary-foreground", on: "primary", where: "primary button" },
  { text: "primary-foreground", on: "danger", where: "danger button" },
];

/** WCAG 2.1 AA for body text (1.4.3). */
export const AA_TEXT = 4.5;

export interface MeasuredPair extends ContrastPair {
  /** The palette (#503) and scheme measured. */
  palette: string;
  theme: ThemeName;
  ratio: number;
}

/**
 * The measured ratios as the Markdown table the accessibility docs page
 * carries. `test/contrast.test.ts` fails when the page's copy is not this
 * table, so the documented numbers are always the shipped ones.
 */
export function contrastTable(css: string): string {
  const measured = measureContrast(css);
  const palettes = [...new Set(measured.map((m) => m.palette))];
  const table = (palette: string) => {
    const ratio = (theme: ThemeName, where: string) =>
      `${measured.find((m) => m.palette === palette && m.theme === theme && m.where === where)?.ratio.toFixed(2)}:1`;
    const rows = CONTRAST_PAIRS.map(
      (p) => `| ${p.where} | ${ratio("dark", p.where)} | ${ratio("light", p.where)} |`,
    );
    return ["| Pairing | Dark | Light |", "| --- | --- | --- |", ...rows].join("\n");
  };
  // One theme is one table; more get a heading each (#503).
  if (palettes.length === 1) return table(palettes[0]);
  return palettes.map((p) => `### ${p}\n\n${table(p)}`).join("\n\n");
}

export function measureContrast(css: string): MeasuredPair[] {
  const blocks = parseThemeBlocks(css);
  return blocks.flatMap(({ palette, scheme, tokens }) => {
    const token = (name: string): Rgb => {
      const rgb = tokens[name];
      if (!rgb) throw new Error(`token --${name} is not defined in ${palette} ${scheme}`);
      return rgb;
    };
    return CONTRAST_PAIRS.map((pair) => {
      const base = token(pair.on);
      const tint = pair.tint;
      const bg = tint ? over(token(tint.token), tint.alpha, base) : base;
      return {
        ...pair,
        palette,
        theme: scheme,
        ratio: contrastRatio(token(pair.text), bg),
      };
    });
  });
}
