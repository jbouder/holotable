/**
 * The theme preference, shared by everything that can change it.
 *
 * It lives here rather than inside `ThemeToggle` because the toggle is no
 * longer the only way in — the command palette can set it too — and two copies
 * of "what counts as a theme, and where is it stored" would drift from each
 * other and from the bootstrap script in the root layout, which resolves the
 * same value before first paint.
 */

export const THEMES = ["dark", "light", "system"] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_STORAGE_KEY = "theme";

/**
 * What the server renders and what the client hydrates with. The inline
 * bootstrap script in the root layout falls back to the same value, so the two
 * have to stay in step.
 */
export const DEFAULT_THEME: Theme = "dark";

/**
 * Broadcast when the preference changes, so a control that is not the one that
 * changed it still shows the truth. A `storage` event would not do: the browser
 * fires that in *other* tabs only.
 */
export const THEME_EVENT = "holotable:theme";

export function isTheme(value: string | null | undefined): value is Theme {
  return THEMES.includes(value as Theme);
}

/** The stored preference, or the default when storage is unavailable. */
export function savedTheme(): Theme {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(value) ? value : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** Put a resolved theme on `<html>`. Does not store anything. */
export function applyTheme(theme: Theme) {
  const resolved =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;

  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

/** Apply, store, and tell every other control in this tab about it. */
export function setTheme(theme: Theme) {
  applyTheme(theme);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // The selected theme still applies when storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent<Theme>(THEME_EVENT, { detail: theme }));
}
