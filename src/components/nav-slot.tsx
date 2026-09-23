"use client";

import * as React from "react";
import { createPortal } from "react-dom";

/*
 * The slot element, published by a callback ref rather than looked up by id.
 * The bar's markup can be replaced after the first commit (hydration does it
 * on a cold load), and a portal holding the element it found in an effect
 * would keep rendering into the detached one. Every mount and unmount of the
 * slot lands here, and every portal re-targets.
 */
let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

function publish(el: HTMLElement | null) {
  slot = el;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * A place in the top bar that the current page can fill.
 *
 * The bar is rendered once by the root layout and outlives every page, so a
 * page cannot pass it children. It leaves an empty element instead, and a page
 * portals its controls into it with {@link NavPortal}; the controls unmount
 * with the page. Shown from `lg` only — below that the bar has no room, and a
 * page is expected to render the same controls in its own body there. The
 * divider hides with it while no page has put anything in.
 */
export function NavSlot() {
  return (
    <div
      ref={publish}
      className="mr-1 hidden items-center gap-2 border-r border-border pr-3 lg:flex lg:empty:hidden"
    />
  );
}

/** Render `children` into the top bar's {@link NavSlot}, once it is mounted. */
export function NavPortal({ children }: { children: React.ReactNode }) {
  const target = React.useSyncExternalStore(
    subscribe,
    () => slot,
    () => null,
  );
  return target ? createPortal(children, target) : null;
}
