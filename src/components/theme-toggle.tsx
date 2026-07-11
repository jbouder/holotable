"use client";

import * as React from "react";
import { Moon, Sun, Monitor } from "lucide-react";
import { cn } from "@/lib/utils";

type Theme = "dark" | "light" | "system";

const STORAGE_KEY = "theme";
const THEMES: Theme[] = ["dark", "light", "system"];

const OPTIONS: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
];

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
      suppressHydrationWarning
      className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-surface-2 p-0.5"
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = theme === value;
        return (
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
