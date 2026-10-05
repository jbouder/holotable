import { resolveOklchToken } from "@/lib/color/oklch";

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

/**
 * Every color token of one theme block in `globals.css`, resolved to sRGB.
 * `:root, [data-theme="dark"]` is the dark set and `[data-theme="light"]` the
 * light one.
 */
export function parseThemeTokens(css: string): Record<ThemeName, Record<string, Rgb>> {
  const block = (selector: RegExp): Record<string, Rgb> => {
    const m = selector.exec(css);
    if (!m) throw new Error(`no theme block matching ${selector}`);
    const body = css.slice(m.index + m[0].length, css.indexOf("}", m.index));
    const out: Record<string, Rgb> = {};
    for (const decl of body.matchAll(/--([a-z0-9-]+):\s*(oklch\([^)]*\))/g)) {
      const hex = resolveOklchToken(decl[2]);
      if (hex) out[decl[1]] = hexToRgb(hex);
    }
    return out;
  };
  return {
    dark: block(/:root,\s*\[data-theme="dark"\]\s*\{/),
    light: block(/\[data-theme="light"\]\s*\{/),
  };
}

/** One way the interface puts text on a background. */
export interface ContrastPair {
  text: string;
  /** The background token, opaque. */
  on: string;
  /** A tint of `tint` at this opacity over `on`, as `bg-<tint>/<n>` draws it. */
  tint?: { token: string; alpha: number };
  /** Where it is used, so a failure says what to look at. */
  where: string;
}

/**
 * What text sits on. `surface-3` is not here: it is only ever a hover fill
 * behind `text-foreground` (menu triggers, card actions), listed on its own.
 */
const SURFACES = ["background", "surface", "surface-2"] as const;
const STATUS = ["danger", "warning", "success"] as const;

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
  { text: "primary-foreground", on: "primary", where: "primary button" },
  { text: "primary-foreground", on: "danger", where: "danger button" },
];

/** WCAG 2.1 AA for body text (1.4.3). */
export const AA_TEXT = 4.5;

export interface MeasuredPair extends ContrastPair {
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
  const ratio = (theme: ThemeName, where: string) =>
    `${measured.find((m) => m.theme === theme && m.where === where)?.ratio.toFixed(2)}:1`;
  const rows = CONTRAST_PAIRS.map(
    (p) => `| ${p.where} | ${ratio("dark", p.where)} | ${ratio("light", p.where)} |`,
  );
  return ["| Pairing | Dark | Light |", "| --- | --- | --- |", ...rows].join("\n");
}

export function measureContrast(css: string): MeasuredPair[] {
  const themes = parseThemeTokens(css);
  return THEMES.flatMap((theme) => {
    const t = themes[theme];
    const token = (name: string): Rgb => {
      const rgb = t[name];
      if (!rgb) throw new Error(`token --${name} is not defined in the ${theme} theme`);
      return rgb;
    };
    return CONTRAST_PAIRS.map((pair) => {
      const base = token(pair.on);
      const bg = pair.tint ? over(token(pair.tint.token), pair.tint.alpha, base) : base;
      return { ...pair, theme, ratio: contrastRatio(token(pair.text), bg) };
    });
  });
}
