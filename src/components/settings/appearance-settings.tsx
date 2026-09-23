"use client";

import type * as React from "react";
import { THEME_OPTIONS, useThemePreference } from "@/components/theme-toggle";
import { useMotionPreference } from "@/components/motion-preference";
import type { Motion } from "@/lib/motion";
import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const MOTION_OPTIONS: { value: Motion; label: string; hint: string }[] = [
  {
    value: "system",
    label: "Follow system",
    hint: "Reduce motion when your operating system asks for it.",
  },
  {
    value: "reduce",
    label: "Reduce",
    hint: "No chart animation, transitions or shimmer.",
  },
  { value: "allow", label: "Allow", hint: "Animate even when the system asks for less." },
];

/** A miniature of the palette, drawn with the real tokens under `data-theme`. */
function Swatch({ theme }: { theme: "light" | "dark" }) {
  return (
    <span
      data-theme={theme}
      className="flex h-full flex-1 flex-col gap-1 bg-background p-1.5"
    >
      <span className="h-2 w-3/4 bg-surface-2" />
      <span className="flex flex-1 gap-1">
        <span className="flex-1 border border-border bg-surface" />
        <span className="w-2 bg-primary" />
      </span>
    </span>
  );
}

function Preview({ theme }: { theme: Theme }) {
  return (
    <span aria-hidden className="flex h-14 w-full overflow-hidden border border-border">
      {theme === "system" ? (
        <>
          <Swatch theme="light" />
          <Swatch theme="dark" />
        </>
      ) : (
        <Swatch theme={theme} />
      )}
    </span>
  );
}

/**
 * One native radio, visually a card. The `<input>` stays in the DOM (only
 * visually hidden) and the whole card is its `<label>`, so keyboard, screen
 * reader and form semantics are the browser's own.
 */
function Choice({
  name,
  value,
  checked,
  onChange,
  children,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  children: React.ReactNode;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer flex-col gap-2 border p-3 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-primary",
        checked
          ? "border-primary bg-surface"
          : "border-border bg-surface hover:bg-surface-2",
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        className="sr-only"
      />
      {children}
    </label>
  );
}

/** The `/settings/appearance` controls (#212). Both apply at once and are per browser. */
export function AppearanceSettings() {
  const [theme, setTheme] = useThemePreference();
  const [motion, setMotion] = useMotionPreference();

  return (
    <>
      <fieldset>
        <legend className="text-sm font-semibold">Theme</legend>
        <p className="mt-1 text-sm text-muted">
          Also in the account menu and the command palette.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {THEME_OPTIONS.map(({ value, label, Icon }) => (
            <Choice
              key={value}
              name="theme"
              value={value}
              checked={theme === value}
              onChange={() => setTheme(value)}
            >
              <Preview theme={value} />
              <span className="flex items-center gap-2">
                <Icon className="h-4 w-4" aria-hidden /> {label}
              </span>
            </Choice>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-sm font-semibold">Motion</legend>
        <p className="mt-1 text-sm text-muted">
          Chart animation, transitions and loading shimmer.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {MOTION_OPTIONS.map(({ value, label, hint }) => (
            <Choice
              key={value}
              name="motion"
              value={value}
              checked={motion === value}
              onChange={() => setMotion(value)}
            >
              <span className="font-medium">{label}</span>
              <span className="text-xs text-muted">{hint}</span>
            </Choice>
          ))}
        </div>
      </fieldset>

      <p className="text-xs text-muted">
        These settings are kept in this browser and apply before the page draws.
      </p>
    </>
  );
}
