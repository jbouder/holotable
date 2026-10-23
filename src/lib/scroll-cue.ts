/**
 * The "N more below" cue over a scrolled list of tiles (#645): where it
 * starts, and how many tiles it stands for.
 *
 * The cue is opaque, so whatever it covers counts as out of view. It starts
 * `cueHeight` above the bottom of the view and moves up to the top of any
 * tile it would cut, so no tile in view is ever drawn cut through its text:
 * a partly visible row is covered whole and counted with the rest.
 */

/** A tile's top and bottom, in pixels from the top of the view. */
export interface TileSpan {
  top: number;
  bottom: number;
}

export interface ScrollCue {
  /** How far above the bottom of the view the cue starts. */
  cover: number;
  /** Tiles under the cue or below it. */
  hidden: number;
  /** How far to scroll to bring the first of them to the top of the view. */
  next: number;
}

/** Below a pixel is rounding, not a tile out of view. */
const EPSILON = 1;

export function scrollCue(
  tiles: readonly TileSpan[],
  height: number,
  cueHeight: number,
): ScrollCue | null {
  if (!tiles.some((t) => t.bottom > height + EPSILON)) return null;
  let top = height - cueHeight;
  let squeezed = false;
  for (;;) {
    const cut = tiles.filter((t) => t.top < top - EPSILON && t.bottom > top + EPSILON);
    if (cut.length === 0) break;
    const raised = Math.min(...cut.map((t) => t.top));
    // A view with no other tile in it above the cue keeps the cue its own height
    // rather than covering everything, and the tile it cuts counts as in view.
    if (!tiles.some((t) => t.bottom > EPSILON && t.bottom <= raised + EPSILON)) {
      squeezed = true;
      break;
    }
    top = raised;
  }
  const hidden = tiles.filter(
    (t) => t.bottom > top + EPSILON && !(squeezed && t.top < top - EPSILON),
  );
  if (hidden.length === 0) return null;
  return {
    cover: height - top,
    hidden: hidden.length,
    next: Math.max(0, Math.min(...hidden.map((t) => t.top))),
  };
}
