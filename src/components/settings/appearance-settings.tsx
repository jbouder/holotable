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
import { type Palette, PALETTE_INFO, type Theme } from "@/lib/theme";

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

/** A fieldset whose legend names the radio group inside it. */
function Group({
  legend,
  hint,
  children,
}: {
  legend: string;
  hint: string;
  children: (labelledBy: string) => React.ReactNode;
}) {
  const id = React.useId();
  return (
    <fieldset>
      <legend id={id} className="text-sm font-semibold">
        {legend}
      </legend>
      <p className="mt-1 text-sm text-muted">{hint}</p>
      <div className="mt-3">{children(id)}</div>
    </fieldset>
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
  const id = React.useId();

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
    <fieldset>
      <legend id={id} className="text-sm font-semibold">
        Patterns in charts
      </legend>
      <p className="mt-1 text-sm text-muted">
        Fill bars, slices and areas with patterns as well as colors, so series can be told
        apart without color.
      </p>
      <ChoiceCardGroup
        value={String(on)}
        onValueChange={(v) => void save(v === "true")}
        labelledBy={id}
        className="mt-3 sm:grid-cols-2"
      >
        <ChoiceCard value="false" label="Off" description="Solid colors." />
        <ChoiceCard
          value="true"
          label="On"
          description="Each series also gets a pattern."
        />
      </ChoiceCardGroup>
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/**
 * The `/settings/appearance` controls (#212). Theme and motion apply at once
 * and are per browser; patterns in charts is saved to the account.
 */
export function AppearanceSettings({ chartPatterns }: { chartPatterns: boolean }) {
  const [theme, setTheme] = useThemePreference();
  const [palette, setPalette] = usePalettePreference();
  const [motion, setMotion] = useMotionPreference();

  return (
    <>
      <Group
        legend="Color scheme"
        hint="Also in the account menu and the command palette."
      >
        {(labelledBy) => (
          <ChoiceCardGroup
            value={theme}
            onValueChange={setTheme}
            labelledBy={labelledBy}
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
      {PALETTE_INFO.length > 1 && (
        <Group
          legend="Theme"
          hint="The colors the app is drawn in. Each is shown in the color scheme above."
        >
          {(labelledBy) => (
            <ChoiceCardGroup
              value={palette}
              onValueChange={setPalette}
              labelledBy={labelledBy}
              className="sm:grid-cols-2 lg:grid-cols-3"
            >
              {PALETTE_INFO.map((p) => (
                <ChoiceCard
                  key={p.name}
                  value={p.name}
                  label={p.label}
                  description={p.description}
                >
                  <ThemePreview palette={p.name} scheme={theme} />
                </ChoiceCard>
              ))}
            </ChoiceCardGroup>
          )}
        </Group>
      )}

      <Group legend="Motion" hint="Chart animation, transitions and loading shimmer.">
        {(labelledBy) => (
          <ChoiceCardGroup
            value={motion}
            onValueChange={setMotion}
            labelledBy={labelledBy}
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
        draws.
      </p>

      <ChartPatternsSetting initial={chartPatterns} />

      <p className="text-xs text-muted">
        Patterns in charts is saved to your account, so it follows you to any device.
      </p>
    </>
  );
}
