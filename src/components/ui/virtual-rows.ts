"use client";

import * as React from "react";

/**
 * Windowed rows for a scroll container (#499): only the rows in view, and a
 * few either side, are in the DOM, with space above and below standing in for
 * the rest, so a table or a log of thousands of rows scrolls like one of
 * thirty.
 *
 * Rows may differ in height (a log line that wraps or is expanded): each
 * rendered row is measured as it lays out, and a row not yet seen counts as
 * `estimate`. Positions are kept by key, so a row keeps its measured height
 * when rows arrive above it.
 *
 * The caller owns the markup: it renders rows `start` to `end` (exclusive),
 * puts `before` and `after` of space around them, and hands each row
 * `measure(key)` as its ref and its key as `data-vkey`.
 */
export function useVirtualRows<E extends HTMLElement>({
  scrollRef,
  keys,
  estimate,
  overscan = 10,
}: {
  scrollRef: React.RefObject<E | null>;
  /** One key per row, in order. */
  keys: readonly string[];
  /** A row's height before it has been measured, in pixels. */
  estimate: number;
  /** Rows rendered beyond the viewport on each side. */
  overscan?: number;
}) {
  const heights = React.useRef(new Map<string, number>());
  const [measured, bump] = React.useReducer((n: number) => n + 1, 0);
  const [view, setView] = React.useState({ top: 0, height: 0 });

  // Where each row starts, by the heights known so far. Recomputed when a
  // measurement changes or rows arrive.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `measured` is the signal that `heights` changed
  const offsets = React.useMemo(() => {
    const out = new Array<number>(keys.length + 1);
    out[0] = 0;
    for (let i = 0; i < keys.length; i++) {
      out[i + 1] = out[i] + (heights.current.get(keys[i]) ?? estimate);
    }
    return out;
  }, [keys, estimate, measured]);

  const read = React.useCallback(() => {
    const el = scrollRef.current;
    if (el) setView({ top: el.scrollTop, height: el.clientHeight });
  }, [scrollRef]);

  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    read();
    el.addEventListener("scroll", read, { passive: true });
    const resize = new ResizeObserver(read);
    resize.observe(el);
    return () => {
      el.removeEventListener("scroll", read);
      resize.disconnect();
    };
  }, [scrollRef, read]);

  // One observer for every rendered row: a row that wraps, expands or
  // collapses reports its new height.
  const observer = React.useRef<ResizeObserver | null>(null);
  React.useEffect(() => {
    observer.current = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        const key = el.dataset.vkey;
        const h = el.offsetHeight;
        if (key !== undefined && h > 0 && heights.current.get(key) !== h) {
          heights.current.set(key, h);
          changed = true;
        }
      }
      if (changed) bump();
    });
    return () => observer.current?.disconnect();
  }, []);

  const measure = React.useCallback((el: HTMLElement | null) => {
    if (!el) return;
    const key = el.dataset.vkey;
    const h = el.offsetHeight;
    if (key !== undefined && h > 0 && heights.current.get(key) !== h) {
      heights.current.set(key, h);
      bump();
    }
    observer.current?.observe(el);
  }, []);

  /** The row at `top` pixels down: the last whose start is at or above it. */
  const indexAt = React.useCallback(
    (top: number) => {
      let lo = 0;
      let hi = keys.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (offsets[mid] <= top) lo = mid;
        else hi = mid - 1;
      }
      return Math.max(0, lo);
    },
    [offsets, keys.length],
  );

  const first = keys.length === 0 ? 0 : indexAt(view.top);
  const last =
    keys.length === 0 ? 0 : indexAt(view.top + Math.max(view.height, estimate));
  const start = Math.max(0, first - overscan);
  const end = Math.min(keys.length, last + 1 + overscan);
  return {
    start,
    end,
    before: offsets[start] ?? 0,
    after: (offsets[keys.length] ?? 0) - (offsets[end] ?? 0),
    measure,
    /** Where a row starts, in pixels from the top of the list. */
    offsetOf: (index: number) => offsets[Math.max(0, Math.min(index, keys.length))] ?? 0,
    indexAt,
    /** Read the container again, after scrolling it from code. */
    refresh: read,
  };
}
