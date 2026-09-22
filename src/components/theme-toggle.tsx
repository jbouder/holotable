"use client";

import * as React from "react";
import { Moon, Sun, Monitor } from "lucide-react";
import { cn } from "@/lib/utils";

type Theme = "dark" | "light" | "system";

const STORAGE_KEY = "theme";
const THEMES: Theme[] = ["dark", "light", "system"];

/**
 * What the server renders and what the client hydrates with. The inline
 * bootstrap script in the root layout falls back to the same value, so the two
 * have to stay in step.
 */
const DEFAULT_THEME: Theme = "dark";

const OPTIONS: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
];

function isTheme(value: string | null): value is Theme {
  return THEMES.includes(value as Theme);
}

function savedTheme(): Theme {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return isTheme(value) ? value : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function applyTheme(theme: Theme) {
  const resolved =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;

  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

export function ThemeToggle() {
  // Not savedTheme(): the server has no localStorage, so the first client
  // render has to agree with what the server sent or hydration mismatches, and
  // React does not patch up the attributes it disagrees on -- the toggle would
  // keep the wrong button `aria-checked` and highlighted until something else
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
  // applied by updateTheme at the click.
  React.useEffect(() => {
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => applyTheme("system");
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, [theme]);

  function updateTheme(value: Theme) {
    setTheme(value);
    applyTheme(value);
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // The selected theme still applies when storage is unavailable.
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-surface-2 p-0.5"
    >
      {OPTIONS.map(({ value, label, Icon }) => {
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
              "flex h-7 w-7 items-center justify-center rounded-md transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-primary",
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
