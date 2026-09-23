/**
 * The reduced-motion preference (#212), shaped like the theme in
 * `src/lib/theme.ts` and for the same reasons.
 *
 * The choice is stored per browser and resolved to `reduce` or `allow` on
 * `<html data-motion>` before first paint by the root layout's bootstrap
 * script, so CSS and the chart wrapper read one attribute instead of each
 * re-deciding. "system" follows `prefers-reduced-motion`.
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
