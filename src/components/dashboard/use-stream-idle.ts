"use client";

import * as React from "react";
import { ACTIVITY_EVENTS, createHiddenWatch, createIdleWatch } from "@/lib/stream-idle";

/**
 * True once the page has been hidden for `graceMs`, false as soon as it is
 * shown. A tab opened in the background counts as hidden from the start.
 */
export function useHiddenFor(graceMs: number): boolean {
  const [suspended, setSuspended] = React.useState(false);
  React.useEffect(() => {
    const watch = createHiddenWatch(graceMs, setSuspended);
    const onChange = () => watch.visibility(document.hidden);
    onChange();
    document.addEventListener("visibilitychange", onChange);
    return () => {
      document.removeEventListener("visibilitychange", onChange);
      watch.dispose();
    };
  }, [graceMs]);
  return suspended;
}

/**
 * Calls `onIdle` after `idleMs` without pointer, keyboard, wheel or touch
 * activity while `enabled`. `idleMs` undefined turns it off. Re-enabling
 * starts the clock again.
 */
export function useIdle(
  idleMs: number | undefined,
  enabled: boolean,
  onIdle: () => void,
): void {
  // Read through a ref so a new callback identity does not restart the clock.
  const onIdleRef = React.useRef(onIdle);
  React.useEffect(() => {
    onIdleRef.current = onIdle;
  });

  React.useEffect(() => {
    if (idleMs === undefined || !enabled) return;
    const watch = createIdleWatch(idleMs, () => onIdleRef.current());
    const onActivity = () => watch.activity();
    for (const type of ACTIVITY_EVENTS) {
      window.addEventListener(type, onActivity, { passive: true, capture: true });
    }
    return () => {
      for (const type of ACTIVITY_EVENTS) {
        window.removeEventListener(type, onActivity, { capture: true });
      }
      watch.dispose();
    };
  }, [idleMs, enabled]);
}
