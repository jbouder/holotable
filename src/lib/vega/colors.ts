import { chartPalette } from "@/lib/color/oklch";
import { COLOR_TOKENS, type ColorToken, tokenHex } from "@/lib/panels/colors";

/**
 * A custom visual's colors, from names to paint (#405).
 *
 * A stored spec names colors as tokens (`danger`), chart colors by index
 * (`palette-2`) or `transparent`, never as literals: the walk refuses
 * anything else. Right before compiling, the renderer swaps each name for the
 * color the other chart kinds paint for it, through the same OKLCH values,
 * so a custom visual's red is the gauge's red. The spec is copied; the stored
 * one keeps its names.
 *
 * The places a color can be are the walk's: a `color`, `fill`, `stroke` or
 * `background` value, any `…Color` key, and, under a color channel, a `value`
 * or a scale's `range`.
 */

const PALETTE = chartPalette();
const COLOR_KEYS = new Set(["color", "fill", "stroke", "background"]);
const isColorKey = (key: string) => COLOR_KEYS.has(key) || /[a-z]Color$/.test(key);

/** A color name as paint, or the input when it is not one. */
export function vegaColor(name: string): string {
  if (name in COLOR_TOKENS) return tokenHex(name as ColorToken);
  const palette = /^palette-(\d+)$/.exec(name);
  if (palette) return PALETTE[Number(palette[1]) % PALETTE.length] ?? name;
  return name;
}

/** A copy of the spec with every color name resolved. */
export function resolveVegaColors(spec: unknown): unknown {
  const paint = (v: unknown) => (typeof v === "string" ? vegaColor(v) : v);
  const walk = (node: unknown, inColor: boolean): unknown => {
    if (Array.isArray(node)) return node.map((item) => walk(item, inColor));
    if (typeof node !== "object" || node === null) return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (isColorKey(key)) {
        out[key] = typeof value === "string" ? paint(value) : walk(value, true);
      } else if (inColor && key === "value") {
        out[key] = paint(value);
      } else if (inColor && key === "range" && Array.isArray(value)) {
        out[key] = value.map(paint);
      } else {
        out[key] = walk(value, inColor && key !== "legend");
      }
    }
    return out;
  };
  return walk(spec, false);
}
