"use client";

import * as React from "react";
import { useSetChartPatterns } from "@/components/chart-patterns";
import {
  THEME_OPTIONS,
  usePalettePreference,
  useThemePreference,
} from "@/components/theme-toggle";
import { useMotionPreference } from "@/components/motion-preference";
import type { Motion } from "@/lib/motion";
import { ThemePreview } from "@/components/settings/theme-preview";
import { ChoiceCard, ChoiceCardGroup } from "@/components/ui/choice-card";
import type { Palette, PaletteInfo, Theme } from "@/lib/theme";

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
function Swatch({ theme, palette }: { theme: "light" | "dark"; palette?: Palette }) {
  return (
    <span
      data-theme={theme}
      data-palette={palette}
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

function SchemePreview({ theme, palette }: { theme: Theme; palette: Palette }) {
  return (
    <span className="flex h-14 w-full overflow-hidden rounded-lg border border-border">
      {theme === "system" ? (
        <>
          <Swatch theme="light" palette={palette} />
          <Swatch theme="dark" palette={palette} />
        </>
      ) : (
        <Swatch theme={theme} palette={palette} />
      )}
    </span>
  );
}

/**
 * A heading and a hint over one radio group, which they name and describe.
 * Not a fieldset: its legend would name a second group around the same
 * choice, and a screen reader would announce it twice.
 */
function Group({
  legend,
  hint,
  children,
}: {
  legend: string;
  hint: string;
  children: (ids: { labelledBy: string; describedBy: string }) => React.ReactNode;
}) {
  const id = React.useId();
  return (
    <div>
      <p id={`${id}-label`} className="text-sm font-semibold">
        {legend}
      </p>
      <p id={`${id}-hint`} className="mt-1 text-sm text-muted">
        {hint}
      </p>
      <div className="mt-3">
        {children({ labelledBy: `${id}-label`, describedBy: `${id}-hint` })}
      </div>
    </div>
  );
}

/**
 * Patterns in charts (#77): a synced preference, saved to the account on
 * change and then set for this page, so its charts follow at once.
 */
function ChartPatternsSetting({ initial }: { initial: boolean }) {
  const apply = useSetChartPatterns();
  const [on, setOn] = React.useState(initial);
  const [error, setError] = React.useState<string | null>(null);

  async function save(value: boolean) {
    const previous = on;
    setOn(value);
    setError(null);
    try {
      const res = await fetch("/api/me/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chartPatterns: value }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      apply(value);
    } catch {
      setOn(previous);
      setError("Could not save that setting. Nothing was changed.");
    }
  }

  return (
    <div>
      <Group
        legend="Patterns in charts"
        hint="Fill bars, slices and areas with patterns as well as colors, so series can be told apart without color."
      >
        {(ids) => (
          <ChoiceCardGroup
            value={String(on)}
            onValueChange={(v) => void save(v === "true")}
            {...ids}
            className="sm:grid-cols-2"
          >
            <ChoiceCard value="false" label="Off" description="Solid colors." />
            <ChoiceCard
              value="true"
              label="On"
              description="Each series also gets a pattern."
            />
          </ChoiceCardGroup>
        )}
      </Group>
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The `/settings/appearance` controls (#212). Theme and motion apply at once
 * and are per browser; patterns in charts is saved to the account.
 */
export function AppearanceSettings({
  chartPatterns,
  palettes,
}: {
  chartPatterns: boolean;
  /** The themes on offer, from the server, so both renders list the same. */
  palettes: readonly PaletteInfo[];
}) {
  const [theme, setTheme] = useThemePreference();
  const [palette, setPalette] = usePalettePreference();
  const [motion, setMotion] = useMotionPreference();

  return (
    <>
      <Group
        legend="Color scheme"
        hint="Also in the account menu and the command palette."
      >
        {(ids) => (
          <ChoiceCardGroup
            value={theme}
            onValueChange={setTheme}
            {...ids}
            className="sm:grid-cols-3"
          >
            {THEME_OPTIONS.map(({ value, label, Icon }) => (
              <ChoiceCard
                key={value}
                value={value}
                label={
                  <>
                    <Icon className="h-4 w-4" aria-hidden /> {label}
                  </>
                }
              >
                <SchemePreview theme={value} palette={palette} />
              </ChoiceCard>
            ))}
          </ChoiceCardGroup>
        )}
      </Group>

      {/* The named themes (#503), each drawn in the chosen scheme (#507). */}
      {palettes.length > 1 && (
        <Group
          legend="Theme"
          hint="The colors the app is drawn in. Each is shown in the color scheme above."
        >
          {(ids) => (
            <ChoiceCardGroup
              value={palette}
              onValueChange={setPalette}
              {...ids}
              className="sm:grid-cols-2 lg:grid-cols-3"
            >
              {palettes.map((p) => (
                <ChoiceCard
                  key={p.name}
                  value={p.name}
                  label={p.label}
                  description={p.description}
                >
                  <ThemePreview palette={p.name} scheme="chosen" />
                </ChoiceCard>
              ))}
            </ChoiceCardGroup>
          )}
        </Group>
      )}

      <Group legend="Motion" hint="Chart animation, transitions and loading shimmer.">
        {(ids) => (
          <ChoiceCardGroup
            value={motion}
            onValueChange={setMotion}
            {...ids}
            className="sm:grid-cols-3"
          >
            {MOTION_OPTIONS.map(({ value, label, hint }) => (
              <ChoiceCard key={value} value={value} label={label} description={hint} />
            ))}
          </ChoiceCardGroup>
        )}
      </Group>

      <p className="text-xs text-muted">
        Theme, color scheme and motion are kept in this browser and apply before the page
        draws. Until you choose a theme, you get your organization&rsquo;s default, and
        follow it if it changes.
      </p>

      <ChartPatternsSetting initial={chartPatterns} />

      <p className="text-xs text-muted">
        Patterns in charts is saved to your account, so it follows you to any device.
      </p>
    </>
  );
}
