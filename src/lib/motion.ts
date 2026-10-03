/**
 * The reduced-motion preference (#212), shaped like the theme in
 * `src/lib/theme.ts` and for the same reasons, and the platform-only motion
 * helpers that honor it (#234): the Web Animations API here, View Transitions
 * in `src/lib/view-transition.ts`, no library.
 *
 * The choice is stored per browser and resolved to `reduce` or `allow` on
 * `<html data-motion>` before first paint by the root layout's bootstrap
 * script, so CSS and the chart wrapper read one attribute instead of each
 * re-deciding. "system" follows `prefers-reduced-motion`.
 *
 * This module is reached by Server Components (`src/lib/bootstrap.ts` builds
 * the inline script from its constants), so nothing here may import React or
 * `react-dom`. `withViewTransition`, which needs `flushSync`, lives in
 * `src/lib/view-transition.ts` for that reason.
 */

export const MOTIONS = ["system", "reduce", "allow"] as const;
export type Motion = (typeof MOTIONS)[number];

/** What `<html data-motion>` holds once resolved. */
export type ResolvedMotion = "reduce" | "allow";

export const MOTION_STORAGE_KEY = "motion";

/** The bootstrap script falls back to the same value; keep them in step. */
export const DEFAULT_MOTION: Motion = "system";

/** Broadcast in this tab when the preference changes; `storage` only fires in others. */
export const MOTION_EVENT = "holotable:motion";

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export function isMotion(value: string | null | undefined): value is Motion {
  return MOTIONS.includes(value as Motion);
}

/** Pure resolution, shared by {@link applyMotion} and the tests. */
export function resolveMotion(
  motion: Motion,
  systemPrefersReduced: boolean,
): ResolvedMotion {
  if (motion === "system") return systemPrefersReduced ? "reduce" : "allow";
  return motion;
}

/** The stored preference, or the default when storage is unavailable. */
export function savedMotion(): Motion {
  try {
    const value = window.localStorage.getItem(MOTION_STORAGE_KEY);
    return isMotion(value) ? value : DEFAULT_MOTION;
  } catch {
    return DEFAULT_MOTION;
  }
}

/** What `<html data-motion>` says now; falls back to the OS when the attribute is missing. */
export function currentMotion(): ResolvedMotion {
  const value = document.documentElement.dataset.motion;
  if (value === "reduce" || value === "allow") return value;
  return resolveMotion("system", window.matchMedia(REDUCED_MOTION_QUERY).matches);
}

/** Put a resolved motion value on `<html>`. Does not store anything. */
export function applyMotion(motion: Motion) {
  document.documentElement.dataset.motion = resolveMotion(
    motion,
    window.matchMedia(REDUCED_MOTION_QUERY).matches,
  );
}

/** Apply, store, and tell every other control in this tab about it. */
export function setMotion(motion: Motion) {
  applyMotion(motion);
  try {
    window.localStorage.setItem(MOTION_STORAGE_KEY, motion);
  } catch {
    // The choice still applies for this page when storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent<Motion>(MOTION_EVENT, { detail: motion }));
}

/**
 * The non-React answer to "is motion on right now". Components take the same
 * answer from `!useReducedMotion()` in `src/components/motion-preference.tsx`
 * so they re-render when it changes; this is for modules with no render, like
 * `src/lib/theme.ts`.
 */
export function isMotionActive(): boolean {
  return currentMotion() === "allow";
}

/* ---------- Web Animations API ---------- */

/** `--ease-emphasized` from `globals.css`, for WAAPI calls that cannot read a CSS variable. */
export const EASE_EMPHASIZED = "cubic-bezier(0.2, 0, 0, 1)";

/** `--duration-base` from `globals.css`, in milliseconds. */
export const DURATION_BASE_MS = 200;

/**
 * Animate an element out, resolving when done (immediately when disabled).
 * The caller removes the element afterwards; `fill: "forwards"` holds the
 * final frame until it does.
 */
export function animateOut(el: HTMLElement, enabled: boolean): Promise<void> {
  if (!enabled) {
    return Promise.resolve();
  }
  const animation = el.animate(
    [
      { opacity: 1, translate: "0 0", scale: "1" },
      { opacity: 0, translate: "24px 0", scale: "0.98" },
    ],
    { duration: DURATION_BASE_MS, easing: EASE_EMPHASIZED, fill: "forwards" },
  );
  return animation.finished.then(() => undefined);
}
