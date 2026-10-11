import { z } from "zod";
import type { ChartTheme } from "@/lib/color/chart-theme";

/**
 * The colors a spec may name: tokens, never raw colors (invariant 13).
 *
 * A gauge's threshold steps and a state timeline's state colors are authored
 * by a person or by the model, and stored. A stored `#ff0000` would ignore the
 * theme and the token layer for as long as the spec lives, so the IR accepts
 * only these names. Each is a CSS variable in `globals.css`, so it is a
 * different color in each scheme (#502): the status colors are the page's
 * own, and the palette-only ones (`--orange`, `--purple`, `--teal`) name a
 * chart series: Holotable's chart-3, -5 and -6, and whichever series of the
 * same family a theme that orders its series differently points them at
 * (#505).
 */
export const COLOR_TOKENS = {
  success: "--success",
  warning: "--warning",
  danger: "--danger",
  info: "--primary",
  neutral: "--muted",
  orange: "--orange",
  purple: "--purple",
  teal: "--teal",
} as const satisfies Record<string, `--${string}`>;

export type ColorToken = keyof typeof COLOR_TOKENS;

export const ColorToken = z.enum(
  Object.keys(COLOR_TOKENS) as [ColorToken, ...ColorToken[]],
);

/** A token as a canvas paints it, in the page's scheme (`ChartTheme`). */
export function tokenHex(token: ColorToken, theme: ChartTheme): string {
  return theme.tokens[token];
}

/**
 * A token as a CSS color, for markup: `var(--success)`. It follows the
 * scheme by itself, and every token is held to AA as text on the surfaces
 * (`CONTRAST_PAIRS`), so it serves for text as well as a stripe or a fill.
 */
export function tokenCss(token: ColorToken): string {
  return `var(${COLOR_TOKENS[token]})`;
}

/**
 * The tokens a value with no assigned color is given, in order. The semantic
 * three are left out, so an unmapped state never looks like "ok" or "failed".
 */
const FALLBACK: readonly ColorToken[] = ["info", "teal", "purple", "orange", "neutral"];

/**
 * A stable token for a label nothing assigned a color to: the same text always
 * gets the same color, on every panel and across reloads.
 */
export function fallbackToken(label: string): ColorToken {
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) | 0;
  return FALLBACK[Math.abs(hash) % FALLBACK.length];
}

/**
 * What a state is colored when nobody said: the obvious ones read as what
 * they mean, and anything else gets a stable color of its own. Shared by the
 * state timeline and the status grid, so a state is one color on both.
 */
const SEMANTIC_STATES: Record<string, ColorToken> = {
  up: "success",
  ok: "success",
  healthy: "success",
  running: "success",
  success: "success",
  succeeded: "success",
  passing: "success",
  resolved: "success",
  down: "danger",
  error: "danger",
  failed: "danger",
  failure: "danger",
  failing: "danger",
  critical: "danger",
  firing: "danger",
  warn: "warning",
  warning: "warning",
  degraded: "warning",
  pending: "warning",
  unknown: "neutral",
  idle: "neutral",
  stopped: "neutral",
};

/** A state's color when the panel did not assign it one. */
export function defaultStateToken(state: string): ColorToken {
  return SEMANTIC_STATES[state.toLowerCase()] ?? fallbackToken(state);
}
