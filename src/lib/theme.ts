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

/*
 * The named theme (#503): a palette of tokens beside the scheme. `Theme`
 * above keeps meaning light or dark; a palette is which designed set of
 * colors those come in. `<html data-palette>` carries it, resolved before
 * first paint like `data-theme`, and `globals.css` gives a palette its own
 * blocks as `[data-palette="<name>"][data-theme="dark|light"]`. Holotable's
 * are the unqualified blocks, so no attribute and `holotable` are the same
 * page.
 */

/** Every name a palette may have, shipped or reserved for a later phase. */
export const PALETTES = [
  "holotable",
  "graphite",
  "fjord",
  "paper",
  "high-contrast",
] as const;
export type Palette = (typeof PALETTES)[number];

export const PALETTE_STORAGE_KEY = "palette";

/**
 * Where the root layout writes the server's default palette, so a client
 * component can show what a viewer with no choice of their own will see.
 */
export const DEFAULT_PALETTE_ATTRIBUTE = "data-default-palette";

/** The palette when nothing chose one: the server's `THEME_DEFAULT_PALETTE` overrides it. */
export const DEFAULT_PALETTE: Palette = "holotable";

/** Broadcast when the palette changes, as {@link THEME_EVENT} is for the scheme. */
export const PALETTE_EVENT = "holotable:palette";

/** A palette the app ships CSS for, as the controls offer it. */
export interface PaletteInfo {
  name: Palette;
  label: string;
  description: string;
  /**
   * Held to the high-contrast quality tier (#506) rather than the built-in
   * one: every text at 7:1, every edge at 4.5:1, tints as solid fills.
   */
  highContrast?: true;
}

/**
 * The palettes with CSS in `globals.css`, in the order the controls list
 * them. A reserved name not listed here is never offered, and stored or
 * configured falls back to the default.
 */
export const PALETTE_INFO: readonly PaletteInfo[] = [
  {
    name: "holotable",
    label: "Holotable",
    description: "Cool slate surfaces with a blue accent.",
  },
  {
    name: "graphite",
    label: "Graphite",
    description: "Warm neutral grays and a violet accent, so the data is the only color.",
  },
  {
    name: "fjord",
    label: "Fjord",
    description: "Calm blue-green surfaces with a sea-teal accent.",
  },
  {
    name: "paper",
    label: "Paper",
    description: "Ivory and ink with a deep blue accent, for reading like a report.",
  },
  {
    name: "high-contrast",
    label: "High contrast",
    description: "Every text at 7:1 or more, strong edges and solid status fills.",
    highContrast: true,
  },
];

export function isPalette(value: string | null | undefined): value is Palette {
  return PALETTE_INFO.some((p) => p.name === value);
}

/** The stored palette, or `fallback` when none is stored or it is not shipped. */
export function savedPalette(fallback: Palette = DEFAULT_PALETTE): Palette {
  try {
    const value = window.localStorage.getItem(PALETTE_STORAGE_KEY);
    return isPalette(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

/** Put a palette on `<html>`. Does not store anything. */
export function applyPalette(palette: Palette) {
  document.documentElement.dataset.palette = palette;
}

/** Apply, store, and tell every other control in this tab about it. */
export function setPalette(palette: Palette) {
  applyPalette(palette);
  try {
    window.localStorage.setItem(PALETTE_STORAGE_KEY, palette);
  } catch {
    // The palette still applies when storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent<Palette>(PALETTE_EVENT, { detail: palette }));
}
