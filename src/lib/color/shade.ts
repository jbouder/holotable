import { hexToOklch, type Oklch, oklchToHexInGamut } from "@/lib/color/oklch";

/**
 * One color as a set of members that belong together, told apart by rank
 * (#657): a treemap branch's leaves, a sunburst ring, and whatever else
 * draws siblings of one group as blocks (#649).
 *
 * The first (the largest) is the color itself; each one after is a step
 * further toward `toward`, the surface the members sit on, the last
 * `reach` of the way there. The steps are even in OKLCH, lightness and
 * chroma together with the hue held, so they look even in every palette;
 * ECharts' own `colorSaturation` steps in HSL, which is uneven across hues
 * and runs light colors to white. A step that would leave sRGB loses chroma,
 * not hue.
 *
 * No two members share a fill: where a set is long enough that two steps
 * round to the same hex, the later one turns its hue a degree at a time
 * until it is its own. A label on a step takes `inkOn` of it, which always
 * clears AA: black or white reads at 4.58:1 or better on any fill.
 */

/** How far toward the surface the last of a set goes: a little over half. */
export const RANK_REACH = 0.55;

/** The furthest a colliding step's hue turns before it gives up being apart. */
const HUE_TURN_MAX = 60;

/**
 * `count` shades of `color`, strongest first, stepping evenly toward
 * `toward` as far as `reach` (0 keeps every one `color`, 1 ends at
 * `toward`). Every argument is a `#rrggbb` hex; so is every shade.
 */
export function rankShades(
  color: string,
  count: number,
  toward: string,
  reach: number = RANK_REACH,
): string[] {
  if (count <= 0) return [];
  const from = hexToOklch(color);
  const to = hexToOklch(toward);
  const used = new Set<string>();
  const out: string[] = [];
  for (let rank = 0; rank < count; rank++) {
    const t = count === 1 ? 0 : (reach * rank) / (count - 1);
    const step: Oklch = {
      l: from.l + (to.l - from.l) * t,
      c: Math.max(0, from.c + (to.c - from.c) * t),
      h: from.h,
    };
    let hex = oklchToHexInGamut(step);
    // A turn either way, a degree further each time, until it is apart.
    for (let k = 1; used.has(hex) && k <= 2 * HUE_TURN_MAX; k++) {
      const turn = Math.ceil(k / 2) * (k % 2 === 0 ? -1 : 1);
      hex = oklchToHexInGamut({
        ...step,
        // A gray has no hue to turn; give it a trace of one.
        c: Math.max(step.c, 0.01),
        h: (step.h + turn + 360) % 360,
      });
    }
    used.add(hex);
    out.push(hex);
  }
  return out;
}
