import { contrastRatio, type Rgb } from "@/lib/color/contrast";
import { DEFICIENCIES, deltaE, lightnessHue, simulate } from "@/lib/color/cvd";

/**
 * What makes a theme good here (#501, #504), as measurements.
 *
 * Contrast alone held a theme to AA for text and nothing else: a border could
 * vanish into the surface it sat on, the focus ring could be the primary
 * button's own fill, and the status colors could merge for a reader with a
 * color-vision deficiency. Each rule below measures one of those things for
 * one theme in one scheme, against a floor. `qualityReport` returns every
 * measurement, so a failure names the rule, where it was measured and the
 * number, and `npm run themes:check` prints the same report for a designer.
 *
 * Two tiers: the built-in themes are held higher (body text at AAA) than an
 * operator's theme file (phase 7), which only has to clear AA.
 */

export type QualityTier = "builtin" | "operator";

export interface Measurement {
  rule: string;
  where: string;
  measured: number;
  floor: number;
  ok: boolean;
}

type Tokens = Record<string, Rgb>;

export interface ThemeRule {
  id: string;
  /** Why the rule exists, for the report and the docs. */
  why: string;
  measure(t: Tokens, tier: QualityTier): Omit<Measurement, "rule" | "ok">[];
}

const SURFACES = ["background", "surface", "surface-2"] as const;
const STATUS = ["success", "warning", "danger"] as const;
const SERIES = Array.from({ length: 8 }, (_, i) => `chart-${i + 1}`);

function get(t: Tokens, name: string): Rgb {
  const rgb = t[name];
  if (!rgb) throw new Error(`the theme has no --${name}`);
  return rgb;
}

const ratio = (t: Tokens, fg: string, bg: string) =>
  contrastRatio(get(t, fg), get(t, bg));

/** Every unordered pair of a list. */
function pairs<T>(xs: readonly T[]): [T, T][] {
  return xs.flatMap((a, i) => xs.slice(i + 1).map((b) => [a, b] as [T, T]));
}

const hueGap = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

export const THEME_RULES: readonly ThemeRule[] = [
  {
    id: "surface-ladder",
    why: "Each surface steps from the one below it: enough to see, not so much that a card shouts.",
    measure: (t) =>
      [
        ["background", "surface"],
        ["surface", "surface-2"],
      ].map(([a, b]) => ({
        where: `${b} against ${a} (OKLab ΔL)`,
        measured: Math.abs(lightnessHue(get(t, a)).l - lightnessHue(get(t, b)).l),
        floor: 0.015,
      })),
  },
  {
    id: "foreground",
    why: "Body text: AAA in a built-in theme, AA in an operator's.",
    measure: (t, tier) =>
      SURFACES.map((s) => ({
        where: `foreground on ${s}`,
        measured: ratio(t, "foreground", s),
        floor: tier === "builtin" ? 7 : 4.5,
      })),
  },
  {
    id: "muted",
    why: "Secondary text is still text: AA on every surface.",
    measure: (t) =>
      SURFACES.map((s) => ({
        where: `muted on ${s}`,
        measured: ratio(t, "muted", s),
        floor: 4.5,
      })),
  },
  {
    id: "border",
    why: "A card's edge is quiet but visible; a control's edge (border-strong) is a 3:1 component boundary (WCAG 1.4.11).",
    measure: (t) =>
      SURFACES.flatMap((s) => [
        { where: `border on ${s}`, measured: ratio(t, "border", s), floor: 1.3 },
        {
          where: `border-strong on ${s}`,
          measured: ratio(t, "border-strong", s),
          floor: 3,
        },
      ]),
  },
  {
    id: "primary",
    why: "The accent reads as text and as a fill, and is never mistaken for a status.",
    measure: (t) => [
      ...SURFACES.map((s) => ({
        where: `primary text on ${s}`,
        measured: ratio(t, "primary", s),
        floor: 4.5,
      })),
      {
        where: "primary fill on surface",
        measured: ratio(t, "primary", "surface"),
        floor: 3,
      },
      ...STATUS.map((s) => ({
        where: `primary hue from ${s} (degrees)`,
        measured: hueGap(lightnessHue(get(t, "primary")).h, lightnessHue(get(t, s)).h),
        floor: 60,
      })),
    ],
  },
  {
    id: "on-fill",
    why: "A filled button's label.",
    measure: (t) =>
      ["primary", "danger"].map((fill) => ({
        where: `primary-foreground on ${fill}`,
        measured: ratio(t, "primary-foreground", fill),
        floor: 4.5,
      })),
  },
  {
    id: "status-distinct",
    why: "Success, warning and danger stay apart, including for a reader with a color-vision deficiency.",
    measure: (t) =>
      pairs(STATUS).flatMap(([a, b]) => [
        {
          where: `${a} vs ${b} (OKLab ΔE)`,
          measured: deltaE(get(t, a), get(t, b)),
          floor: 0.12,
        },
        ...DEFICIENCIES.map((d) => ({
          where: `${a} vs ${b} under ${d} (OKLab ΔE)`,
          measured: deltaE(simulate(get(t, a), d), simulate(get(t, b), d)),
          floor: 0.05,
        })),
      ]),
  },
  {
    id: "chart-series",
    why: "Every series is a 3:1 graphic on the surface, and no two are near-twins, with or without a color-vision deficiency.",
    measure: (t) => [
      ...SERIES.map((s) => ({
        where: `${s} on surface`,
        measured: ratio(t, s, "surface"),
        floor: 3,
      })),
      {
        where: "closest two series (OKLab ΔE)",
        measured: Math.min(
          ...pairs(SERIES).map(([a, b]) => deltaE(get(t, a), get(t, b))),
        ),
        floor: 0.08,
      },
      ...DEFICIENCIES.map((d) => ({
        where: `closest two series under ${d} (OKLab ΔE)`,
        measured: Math.min(
          ...pairs(SERIES).map(([a, b]) =>
            deltaE(simulate(get(t, a), d), simulate(get(t, b), d)),
          ),
        ),
        floor: 0.02,
      })),
    ],
  },
  {
    id: "chart-text",
    why: "Axis labels and legends are text.",
    measure: (t) => [
      {
        where: "chart-text on surface",
        measured: ratio(t, "chart-text", "surface"),
        floor: 4.5,
      },
    ],
  },
  {
    id: "ring",
    why: "Focus is visible on every surface it can be drawn on (WCAG 2.4.11). A filled button draws it 2px out, over the surface, so a gap of surface separates the ring from the fill.",
    measure: (t) =>
      SURFACES.map((s) => ({
        where: `ring on ${s}`,
        measured: ratio(t, "ring", s),
        floor: 3,
      })),
  },
  {
    id: "selection",
    why: "Selected text stays readable.",
    measure: (t) => [
      {
        where: "foreground on selection",
        measured: ratio(t, "foreground", "selection"),
        floor: 4.5,
      },
    ],
  },
  {
    id: "code",
    why: "Syntax colors are text in an editor on the surface.",
    measure: (t) =>
      ["code-keyword", "code-string", "code-number", "code-comment"].map((c) => ({
        where: `${c} on surface`,
        measured: ratio(t, c, "surface"),
        floor: 4.5,
      })),
  },
];

/** Every rule's measurements for one theme in one scheme. */
export function qualityReport(
  tokens: Tokens,
  tier: QualityTier = "builtin",
): Measurement[] {
  return THEME_RULES.flatMap((rule) =>
    rule
      .measure(tokens, tier)
      .map((m) => ({ ...m, rule: rule.id, ok: m.measured >= m.floor })),
  );
}
