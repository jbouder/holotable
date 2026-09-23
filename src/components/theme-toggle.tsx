"use client";

import * as React from "react";
import { Moon, Sun, Monitor } from "lucide-react";
import {
  applyTheme,
  DEFAULT_THEME,
  savedTheme,
  setTheme as storeTheme,
  type Theme,
  THEME_EVENT,
} from "@/lib/theme";
import { cn } from "@/lib/utils";

export const THEME_OPTIONS: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
];

/**
 * The theme preference as React state, for any control that shows or changes
 * it: this toggle, the profile menu, the appearance settings. Each follows the
 * shared preference through {@link THEME_EVENT} rather than owning it, so
 * changing it in one place updates the others in the same tab.
 */
export function useThemePreference(): [Theme, (value: Theme) => void] {
  // Not savedTheme(): the server has no localStorage, so the first client
  // render has to agree with what the server sent or hydration mismatches, and
  // React does not patch up the attributes it disagrees on -- the control would
  // keep the wrong item `aria-checked` and highlighted until something else
  // re-rendered it.
  const [theme, setTheme] = React.useState<Theme>(DEFAULT_THEME);

  // Adopt the stored preference once, after hydration. Applying it here is
  // all but redundant -- the layout's bootstrap script resolved the same value
  // before first paint -- but it keeps <html> correct if that script was
  // blocked, and it cannot flash, because it applies the stored theme rather
  // than the DEFAULT_THEME the state still holds.
  React.useEffect(() => {
    const stored = savedTheme();
    setTheme(stored);
    applyTheme(stored);
  }, []);

  // Follow the OS only while "system" is selected. Every other transition is
  // applied by update at the click.
  React.useEffect(() => {
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => applyTheme("system");
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, [theme]);

  React.useEffect(() => {
    const onThemeChange = (e: Event) => setTheme((e as CustomEvent<Theme>).detail);
    window.addEventListener(THEME_EVENT, onThemeChange);
    return () => window.removeEventListener(THEME_EVENT, onThemeChange);
  }, []);

  const update = React.useCallback((value: Theme) => {
    setTheme(value);
    storeTheme(value);
  }, []);

  return [theme, update];
}

export function ThemeToggle() {
  const [theme, updateTheme] = useThemePreference();

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="inline-flex items-center gap-0.5 border border-border bg-surface-2 p-0.5"
    >
      {THEME_OPTIONS.map(({ value, label, Icon }) => {
        const active = theme === value;
        return (
          // The WAI-ARIA radio group pattern: a role="radiogroup" container of
          // role="radio" buttons. Real <input type="radio"> elements cannot
          // carry the icon-button styling this control needs.
          // biome-ignore lint/a11y/useSemanticElements: APG radio group pattern
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={() => updateTheme(value)}
            className={cn(
              "tap-target flex h-7 w-7 items-center justify-center transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-primary",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted hover:bg-surface hover:text-foreground",
            )}
          >
            <Icon className="h-4 w-4" />
          </button>
        );
      })}
    </div>
  );
}
