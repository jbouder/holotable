import { type RefObject, useLayoutEffect, useRef } from "react";
import { EASE_EMPHASIZED } from "@/lib/motion";

/**
 * FLIP for a list (#237): after every render, compare each `[data-flip-id]`
 * descendant's box with where it was last time and animate the difference
 * with WAAPI. Layout does the hard part; this only measures before and after.
 * Ported from holocron's `useFlip`, with two changes noted below.
 *
 * Renders happen mid-slide all the time (`router.refresh()` lands a few
 * hundred milliseconds after an optimistic render; SSE updates arrive under a
 * running reorder), and a bounding box measured then includes the slide's
 * translate. So the box is corrected by the running translate to recover the
 * layout position, which is what gets remembered and compared. When layout
 * really did change under a running slide, the new slide starts from where
 * the item visibly is, not from where layout put it, so it never jumps.
 *
 * Boxes are measured relative to the container's scroll origin rather than
 * the viewport (the first change): the command palette's list scrolls its
 * active option into view between renders, and in viewport coordinates that
 * scroll would read as every option having moved. The second change is the
 * `animate` guard, so a render in jsdom never throws.
 */

interface Point {
  left: number;
  top: number;
}

export interface FlipOptions {
  /** Defaults to `--duration-slow`; a list that re-ranks while typing wants `--duration-fast`. */
  durationMs?: number;
}

const DURATION_SLOW_MS = 350;

/** The element's current `translate`, from a slide in progress or none. */
function currentTranslate(el: HTMLElement): Point {
  const value = getComputedStyle(el).translate;
  if (!value || value === "none") {
    return { left: 0, top: 0 };
  }
  const [x = "0", y = "0"] = value.split(" ");
  return { left: Number.parseFloat(x) || 0, top: Number.parseFloat(y) || 0 };
}

export function useFlip(
  containerRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  { durationMs = DURATION_SLOW_MS }: FlipOptions = {},
) {
  const previous = useRef(new Map<string, Point>());
  const sliding = useRef(new WeakMap<HTMLElement, Animation>());

  // No dependency array on purpose: measure after every render.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const origin = container.getBoundingClientRect();
    const scroll = { left: container.scrollLeft, top: container.scrollTop };
    const next = new Map<string, Point>();
    for (const el of container.querySelectorAll<HTMLElement>("[data-flip-id]")) {
      const id = el.dataset.flipId;
      if (!id) {
        continue;
      }
      const slide = sliding.current.get(el);
      const offset =
        slide && slide.playState === "running"
          ? currentTranslate(el)
          : { left: 0, top: 0 };
      const box = el.getBoundingClientRect();
      // Where layout put it, in the container's scroll space, with any slide
      // in progress taken back out.
      const last: Point = {
        left: box.left - origin.left + scroll.left - offset.left,
        top: box.top - origin.top + scroll.top - offset.top,
      };
      next.set(id, last);
      const first = previous.current.get(id);
      if (!first || !enabled || typeof el.animate !== "function") {
        continue;
      }
      const dx = first.left - last.left;
      const dy = first.top - last.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
        // Layout is unchanged; a slide in progress carries on untouched.
        continue;
      }
      // Start from where the item visibly is right now.
      slide?.cancel();
      const animation = el.animate(
        [
          { translate: `${dx + offset.left}px ${dy + offset.top}px` },
          { translate: "0 0" },
        ],
        { duration: durationMs, easing: EASE_EMPHASIZED },
      );
      sliding.current.set(el, animation);
    }
    previous.current = next;
  });
}
