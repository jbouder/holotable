import { flushSync } from "react-dom";

/**
 * The View Transitions half of the motion helpers (#234).
 *
 * Separate from `src/lib/motion.ts` because `flushSync` is a Client
 * Component API: Turbopack refuses to bundle a module that imports it into a
 * Server Component, and `motion.ts` is reached by one through
 * `src/lib/bootstrap.ts`. Import this module only from client code, and take
 * `enabled` from `!useReducedMotion()` (or `isMotionActive()` outside React).
 */

/**
 * Run a React state update inside a view transition, or just run it.
 *
 * `type` lands on `<html data-vt="…">` for the life of the transition so the
 * stylesheet can scope `view-transition-name`s: a tab panel only gets its own
 * snapshot during a tab change, the page only during navigation. The update
 * is flushed synchronously inside the callback so the "new" snapshot is taken
 * after React has committed it.
 */
export function withViewTransition(
  update: () => void,
  enabled: boolean,
  type = "default",
) {
  if (!enabled || typeof document.startViewTransition !== "function") {
    update();
    return;
  }
  const root = document.documentElement;
  root.dataset.vt = type;
  const transition = document.startViewTransition(() => {
    flushSync(update);
  });
  // A skipped transition (hidden tab, another one in flight) rejects these;
  // the DOM update has still happened, so there is nothing to handle.
  transition.ready.catch(() => undefined);
  transition.finished
    .catch(() => undefined)
    .then(() => {
      if (root.dataset.vt === type) {
        delete root.dataset.vt;
      }
    });
}
