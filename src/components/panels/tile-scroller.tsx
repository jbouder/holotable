"use client";

import * as React from "react";
import { isMotionActive } from "@/lib/motion";
import { type ScrollCue, scrollCue } from "@/lib/scroll-cue";

/** The cue's own height before it moves up over a cut row: one `text-xs` line and its padding. */
const CUE_REM = 1.5;

/**
 * A focusable scroll region over a list of tiles that says when some are out
 * of view (#645): a fade in the surface color over the clipped edge, and a
 * muted "N more below" that scrolls to them. It covers a partly visible row
 * whole, so no tile is drawn cut through its value.
 *
 * The region stays the keyboard's way to scroll; the cue is a pointer
 * shortcut, out of the tab order and hidden from screen readers, which read
 * every tile in the list anyway.
 */
export function TileScroller({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const scroller = React.useRef<HTMLElement>(null);
  const [cue, setCue] = React.useState<ScrollCue | null>(null);
  const [gutter, setGutter] = React.useState(0);

  const measure = React.useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const view = el.getBoundingClientRect().top + el.clientTop;
    const tiles = Array.from(el.querySelectorAll<HTMLElement>("[data-tile]"), (t) => {
      const r = t.getBoundingClientRect();
      return { top: r.top - view, bottom: r.bottom - view };
    });
    const rem =
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const next = scrollCue(tiles, el.clientHeight, CUE_REM * rem);
    setCue((prev) =>
      prev?.cover === next?.cover &&
      prev?.hidden === next?.hidden &&
      prev?.next === next?.next
        ? prev
        : next,
    );
    setGutter(el.offsetWidth - el.clientWidth - el.clientLeft * 2);
  }, []);

  React.useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    measure();
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    el.addEventListener("scroll", schedule, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      el.removeEventListener("scroll", schedule);
    };
  }, [measure]);

  // New tiles from a poll can change the count without changing a size.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the tiles change
  React.useLayoutEffect(measure, [children]);

  function reveal() {
    const el = scroller.current;
    if (!el || !cue) return;
    el.scrollBy({ top: cue.next, behavior: isMotionActive() ? "smooth" : "auto" });
  }

  return (
    <div className="relative flex max-h-full min-h-0 flex-col">
      <section
        ref={scroller}
        aria-label={label}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container must be focusable to scroll by keyboard (WCAG 2.1.1)
        tabIndex={0}
        className="min-h-0 overflow-auto focus-visible:outline-2 focus-visible:outline-ring"
      >
        {children}
      </section>
      {cue && (
        <div
          aria-hidden
          className="pointer-events-none absolute bottom-0 left-0 flex items-end bg-linear-to-b from-transparent to-surface to-[0.5rem]"
          style={{ height: cue.cover, right: gutter }}
        >
          <button
            type="button"
            tabIndex={-1}
            onClick={reveal}
            className="pointer-events-auto w-full cursor-pointer py-0.5 text-left text-xs text-muted hover:text-foreground"
          >
            {cue.hidden} more below
          </button>
        </div>
      )}
    </div>
  );
}
