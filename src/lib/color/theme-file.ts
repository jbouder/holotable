import { z } from "zod";
import {
  AA_TEXT,
  measureBlock,
  resolveBlock,
  type ThemeName,
} from "@/lib/color/contrast";
import { qualityReport } from "@/lib/color/quality";
import { PALETTE_NAME, PALETTES, type Palette, type PaletteInfo } from "@/lib/theme";

/**
 * An operator's own theme (#508): `THEME_FILE`, a JSON file of token values
 * in both schemes, held to the operator tier of the quality bar at boot.
 *
 * It is numbers, not CSS. Every token is an `oklch(L C H)` or a `#rrggbb`,
 * parsed into numbers and written back out by {@link themeCss}, so nothing
 * from the file reaches the page as text: no selector, no URL, no
 * declaration it did not name. The name, label and description reach the
 * theme controls, which React escapes.
 */

/** Every token a theme file sets, in both schemes. */
export const THEME_FILE_TOKENS = [
  "background",
  "surface",
  "surface-2",
  "surface-3",
  "foreground",
  "muted",
  "border",
  "border-strong",
  "ring",
  "selection",
  "primary",
  "primary-foreground",
  "danger",
  "warning",
  "success",
  ...Array.from({ length: 8 }, (_, i) => `chart-${i + 1}`),
  ...Array.from({ length: 5 }, (_, i) => `chart-seq-${i + 1}`),
  "chart-div-low",
  "chart-div-mid",
  "chart-div-high",
  // The spec's palette-only color tokens: which series, by family (#505).
  "orange",
  "purple",
  "teal",
  "code-keyword",
  "code-string",
  "code-number",
  "code-comment",
] as const;

// Bounded, so every value written back is plain decimal: `Number` would turn
// a long fraction into `1e-7`, which no CSS color parser here reads.
const NUMBER = String.raw`(\d{1,3}(?:\.\d{1,6})?)`;
const OKLCH = new RegExp(
  String.raw`^oklch\(\s*${NUMBER}(%?)\s+${NUMBER}\s+${NUMBER}\s*\)$`,
);
const HEX = /^#[0-9a-fA-F]{6}$/;

/** A token's value as numbers, so it can be written back without its text. */
type Color =
  | { kind: "oklch"; l: number; c: number; h: number }
  | { kind: "hex"; hex: string };

const ColorValue = z.string().transform((value, ctx): Color => {
  const v = value.trim();
  if (HEX.test(v)) return { kind: "hex", hex: v.toLowerCase() };
  const m = OKLCH.exec(v);
  if (m) {
    const l = Number(m[1]) / (m[2] ? 100 : 1);
    const c = Number(m[3]);
    const h = Number(m[4]);
    if (l <= 1 && c <= 0.5 && h <= 360) return { kind: "oklch", l, c, h };
  }
  ctx.addIssue({
    code: "custom",
    message: 'must be "oklch(L C H)" (L 0–1 or 0–100%, C 0–0.5, H 0–360) or "#rrggbb"',
  });
  return z.NEVER;
});

const SchemeTokens = z
  .object(
    Object.fromEntries(THEME_FILE_TOKENS.map((t) => [t, ColorValue])) as {
      [K in (typeof THEME_FILE_TOKENS)[number]]: typeof ColorValue;
    },
  )
  .strict();

export const RADII = ["0px", "2px", "4px", "6px"] as const;

export const ThemeFileSchema = z
  .object({
    name: z
      .string()
      .regex(PALETTE_NAME, "must be lowercase letters, digits and dashes, 2–32 long")
      .refine((n) => !(PALETTES as readonly string[]).includes(n), {
        message: "is a built-in theme's name; choose another",
      }),
    label: z.string().trim().min(1).max(40),
    description: z.string().trim().max(120).optional(),
    radius: z.enum(RADII).optional(),
    light: SchemeTokens,
    dark: SchemeTokens,
  })
  .strict();

export type ThemeFile = z.infer<typeof ThemeFileSchema>;

/** The file's text, parsed and checked for shape, or every problem with it. */
export function parseThemeFile(
  text: string,
): { theme: ThemeFile; problems: [] } | { theme: null; problems: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { theme: null, problems: [`is not JSON (${(err as Error).message})`] };
  }
  const parsed = ThemeFileSchema.safeParse(json);
  if (parsed.success) return { theme: parsed.data, problems: [] };
  return {
    theme: null,
    problems: parsed.error.issues.map(
      (i) => `${i.path.join(".") || "the file"} ${i.message}`,
    ),
  };
}

/** How the controls list it. */
export function themeFileInfo(theme: ThemeFile): PaletteInfo {
  return {
    // ThemeFileSchema held the name to PALETTE_NAME, and off the built-ins.
    name: theme.name as Palette,
    label: theme.label,
    description: theme.description ?? "Your organization's theme.",
  };
}

function colorText(color: Color): string {
  return color.kind === "hex" ? color.hex : `oklch(${color.l} ${color.c} ${color.h})`;
}

/**
 * The theme's two blocks, written from the parsed numbers. The aliases a
 * built-in theme inherits from Holotable's blocks (chart text and grid, the
 * spec's orange, purple and teal, the tints) resolve against these values in
 * the cascade, as they do for a built-in theme.
 */
export function themeCss(theme: ThemeFile): string {
  return (["dark", "light"] as const)
    .map((scheme) => {
      const decls = THEME_FILE_TOKENS.map(
        (t) => `--${t}:${colorText(theme[scheme][t])};`,
      );
      if (theme.radius) decls.push(`--radius:${theme.radius};`);
      return `[data-palette="${theme.name}"][data-theme="${scheme}"]{${decls.join("")}}`;
    })
    .join("\n");
}

/**
 * Holotable's aliases and tint alphas, as its blocks declare them, so a
 * theme file is measured as the cascade paints it.
 */
const INHERITED: Record<string, string> = {
  "chart-text": "var(--muted)",
  "chart-axis": "var(--border)",
  "chart-grid": "var(--surface-2)",
  "chart-track": "var(--surface-2)",
  "tint-5": "5%",
  "tint-10": "10%",
  "tint-15": "15%",
  "tint-20": "20%",
  "tint-danger": "var(--danger)",
  "tint-warning": "var(--warning)",
  "tint-success": "var(--success)",
  "tint-foreground": "var(--foreground)",
  "tinted-foreground": "var(--foreground)",
  "tinted-muted": "var(--muted)",
  "tinted-danger": "var(--danger)",
  "tinted-warning": "var(--warning)",
  "tinted-success": "var(--success)",
};

function block(theme: ThemeFile, scheme: ThemeName) {
  const decls: Record<string, string> = { ...INHERITED };
  for (const t of THEME_FILE_TOKENS) decls[t] = colorText(theme[scheme][t]);
  return { palette: theme.name, scheme, ...resolveBlock(decls) };
}

/**
 * Every pairing and quality rule the theme fails, at the operator tier: AA
 * text, visible borders and focus, statuses and series apart. Each names the
 * rule, the scheme and the number, as "muted on bg-surface-2, light: 4.20:1
 * (needs 4.5:1)".
 */
export function checkThemeFile(theme: ThemeFile): string[] {
  return (["light", "dark"] as const).flatMap((scheme) => {
    const b = block(theme, scheme);
    const contrast = measureBlock(b)
      .filter((m) => m.ratio < (m.floor ?? AA_TEXT))
      .map(
        (m) =>
          `${m.where}, ${scheme}: ${m.ratio.toFixed(2)}:1 (needs ${m.floor ?? AA_TEXT}:1)`,
      );
    const quality = qualityReport(b.tokens, "operator")
      .filter((m) => !m.ok)
      .map(
        (m) =>
          `${m.where}, ${scheme}: ${m.measured.toFixed(2)} (needs ${m.floor}; rule ${m.rule})`,
      );
    return [...contrast, ...quality];
  });
}
