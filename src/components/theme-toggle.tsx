"use client";

import * as React from "react";

type Theme = "dark" | "light" | "system";

const STORAGE_KEY = "theme";
const THEMES: Theme[] = ["dark", "light", "system"];

function isTheme(value: string | null): value is Theme {
  return THEMES.includes(value as Theme);
}

function savedTheme(): Theme {
  if (typeof window === "undefined") return "dark";

  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return isTheme(value) ? value : "dark";
  } catch {
    return "dark";
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
  const [theme, setTheme] = React.useState<Theme>(savedTheme);

  React.useEffect(() => {
    applyTheme(theme);

    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => applyTheme("system");
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, [theme]);

  function updateTheme(event: React.ChangeEvent<HTMLSelectElement>) {
    const value = event.target.value;
    if (!isTheme(value)) return;

    setTheme(value);
    applyTheme(value);
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // The selected theme still applies when storage is unavailable.
    }
  }

  return (
    <label>
      <span className="sr-only">Theme</span>
      <select
        value={theme}
        onChange={updateTheme}
        suppressHydrationWarning
        className="h-8 rounded-lg border border-border bg-surface-2 px-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-primary"
      >
        <option value="dark">Dark</option>
        <option value="light">Light</option>
        <option value="system">System</option>
      </select>
    </label>
  );
}
