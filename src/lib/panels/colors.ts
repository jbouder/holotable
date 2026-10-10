import { z } from "zod";
import { type Oklch, OKLCH_PALETTE, oklchToHex } from "@/lib/color/oklch";

/**
 * The colors a spec may name: tokens, never raw colors (invariant 13).
 *
 * A gauge's threshold steps and a state timeline's state colors are authored
 * by a person or by the model, and stored. A stored `#ff0000` would ignore the
 * theme and the token layer for as long as the spec lives, so the IR accepts
 * only these names, and they are resolved through the same OKLCH values as
 * `--success`, `--warning`, `--danger` and the chart palette in `globals.css`.
 */
export const COLOR_TOKENS = {
  success: { l: 0.7, c: 0.16, h: 160 },
  warning: { l: 0.78, c: 0.16, h: 75 },
  danger: { l: 0.65, c: 0.22, h: 20 },
  info: OKLCH_PALETTE[0],
  neutral: { l: 0.7, c: 0.02, h: 265 },
  orange: OKLCH_PALETTE[2],
  purple: OKLCH_PALETTE[4],
  teal: OKLCH_PALETTE[5],
} as const satisfies Record<string, Oklch>;

export type ColorToken = keyof typeof COLOR_TOKENS;

export const ColorToken = z.enum(
  Object.keys(COLOR_TOKENS) as [ColorToken, ...ColorToken[]],
);

/** A token as a color ECharts can paint. */
export function tokenHex(token: ColorToken): string {
  return oklchToHex(COLOR_TOKENS[token]);
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
