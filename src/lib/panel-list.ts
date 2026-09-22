import { clampLayout, resolveOverlaps } from "@/lib/grid-layout";
import type { Panel } from "@/lib/ir";

/**
 * The panel list's own operations: duplicate, and the four ways to move a
 * panel through the order.
 *
 * The editor's panel list used to support exactly select and delete, so the
 * only way to build a variant of a panel was to add a blank one and retype the
 * SQL, and the only way to change the order was not to have got it wrong.
 *
 * Two rules hold everything here together:
 *
 * - **Order and layout are different things.** The `panels` array order is
 *   what `autoLayoutPanels` flows through and what the list shows; `layout`
 *   is where a panel actually sits on the grid. Reordering therefore touches
 *   *only* the array, so a hand-positioned dashboard survives it — the
 *   arrangement is applied on demand by the existing `Arrange: N-up` presets.
 *   Duplicating is the exception, because a copy has to be placed somewhere.
 * - **One call, one result.** Each function returns the whole next `panels`
 *   array, so the editor records it as a single history entry and every action
 *   is one undo (#81).
 */

/** Where a move sends the panel. */
export type PanelMove = "up" | "down" | "top" | "bottom";

/** Panel ids are `z.string().min(1).max(64)` in the IR. */
const MAX_ID = 64;
/** Panel titles are `z.string().min(1).max(200)`. */
const MAX_TITLE = 200;

/** The index of `id`, or -1. */
function indexOf(panels: Panel[], id: string): number {
  return panels.findIndex((p) => p.id === id);
}

/** Would this move change anything? What the menu greys out. */
export function canMove(panels: Panel[], id: string, move: PanelMove): boolean {
  const i = indexOf(panels, id);
  if (i < 0) return false;
  return move === "up" || move === "top" ? i > 0 : i < panels.length - 1;
}

/** Move one panel through the order, leaving every layout untouched. */
export function movePanel(panels: Panel[], id: string, move: PanelMove): Panel[] {
  const from = indexOf(panels, id);
  if (from < 0) return panels;
  const to =
    move === "up"
      ? from - 1
      : move === "down"
        ? from + 1
        : move === "top"
          ? 0
          : panels.length - 1;
  return reorderPanels(panels, id, to);
}

/**
 * Put `id` at `to`, sliding the rest along — what a drop on the list commits.
 * An index outside the array is clamped rather than refused, because a drop
 * past the last row is a drop on the last row.
 */
export function reorderPanels(panels: Panel[], id: string, to: number): Panel[] {
  const from = indexOf(panels, id);
  if (from < 0) return panels;
  const target = Math.min(panels.length - 1, Math.max(0, Math.trunc(to)));
  if (target === from) return panels;
  const next = [...panels];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  return next;
}

/**
 * A panel id that no panel in the list already has, derived from `base`.
 *
 * Ids are bounded, so the suffix is made room for rather than appended blindly
 * — an id truncated to exactly the length of an existing one would collide,
 * which the dashboard's own uniqueness check would then reject on save.
 */
export function uniquePanelId(panels: Panel[], base: string): string {
  const taken = new Set(panels.map((p) => p.id));
  const stem = base.slice(0, MAX_ID) || "panel";
  if (!taken.has(stem)) return stem;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${stem.slice(0, MAX_ID - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** `"Errors"` → `"Errors (copy)"`, kept inside the IR's title bound. */
export function copyTitle(title: string): string {
  const suffix = " (copy)";
  return `${title.slice(0, MAX_TITLE - suffix.length)}${suffix}`;
}

/**
 * Copy a panel directly below itself.
 *
 * The copy keeps the original's width and height and takes the row under it,
 * then `resolveOverlaps` settles whatever it landed on — the same rule a drag
 * commits through, so a duplicate cannot hide an existing panel.
 *
 * Returns the id of the copy so the editor can select it: the point of
 * duplicating is to then change the copy.
 */
export function duplicatePanel(
  panels: Panel[],
  id: string,
): { panels: Panel[]; id: string } | null {
  const index = indexOf(panels, id);
  if (index < 0) return null;
  const original = panels[index];
  const copyId = uniquePanelId(panels, `${original.id}-copy`);
  const copy: Panel = {
    ...original,
    id: copyId,
    title: copyTitle(original.title),
    query: { ...original.query },
    layout: clampLayout({
      ...original.layout,
      y: original.layout.y + original.layout.h,
    }),
  };
  const next = [...panels.slice(0, index + 1), copy, ...panels.slice(index + 1)];
  return { panels: resolveOverlaps(next, copyId), id: copyId };
}
