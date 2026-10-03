import { isMotionActive } from "@/lib/motion";
import { applyTheme, setTheme, type Theme } from "@/lib/theme";
import { withViewTransition } from "@/lib/view-transition";

/**
 * The theme change as a crossfade (#236).
 *
 * Every way of changing the theme in the browser goes through these two
 * rather than through `src/lib/theme.ts` directly, so they all get the same
 * transition. They live apart from `theme.ts` because that module is reached
 * by Server Components through `src/lib/bootstrap.ts` and must not import
 * `flushSync` (see `view-transition.ts`); this one is client-only.
 *
 * The DOM write happens inside the callback, so the "new" snapshot is taken
 * in the new theme; `globals.css` fades it in over the old one under
 * `html[data-vt="theme"]`. Under Reduce the write is immediate.
 */

/** Apply, store and broadcast, inside a theme crossfade. */
export function setThemeWithTransition(theme: Theme) {
  withViewTransition(() => setTheme(theme), isMotionActive(), "theme");
}

/** Apply only (the OS changed under "system"), inside a theme crossfade. */
export function applyThemeWithTransition(theme: Theme) {
  withViewTransition(() => applyTheme(theme), isMotionActive(), "theme");
}
