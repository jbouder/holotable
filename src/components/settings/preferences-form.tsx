"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/input";
import { Select, type SelectOption } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import type { Preferences, PreferencesPatch } from "@/lib/preferences";
import { formatDateTime, runtimeTimeZone } from "@/lib/time-display";

export interface StartDashboardOption {
  id: string;
  title: string;
  workspaceId: string;
}

const CLOCK_OPTIONS: SelectOption[] = [
  { value: "locale", label: "Locale default" },
  { value: "12h", label: "12-hour" },
  { value: "24h", label: "24-hour" },
];

const SORT_OPTIONS: SelectOption[] = [
  { value: "updated", label: "Recently updated" },
  { value: "created", label: "Recently created" },
  { value: "title", label: "Name" },
];

/** Every zone the browser knows, UTC first; falls back to a short list. */
function zoneOptions(): SelectOption[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = ["America/New_York", "Europe/London", "Europe/Berlin", "Asia/Tokyo"];
  }
  return [
    { value: "local", label: "Browser local" },
    { value: "UTC", label: "UTC" },
    ...zones
      .filter((z) => z !== "UTC")
      .map((z) => ({ value: z, label: z.replace(/_/g, " ") })),
  ];
}

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

/**
 * Every control saves on change: there is no Save button to forget. A save
 * that touches how times are shown refreshes the page's server data, since
 * the root layout reads the preference once per request and hands it down.
 */
export function PreferencesForm({
  initial,
  dashboards,
}: {
  initial: Preferences;
  dashboards: StartDashboardOption[];
}) {
  const router = useRouter();
  const [prefs, setPrefs] = React.useState(initial);
  const [state, setState] = React.useState<SaveState>({ kind: "idle" });
  const zones = React.useMemo(zoneOptions, []);
  const [browserZone, setBrowserZone] = React.useState<string | null>(null);
  React.useEffect(() => setBrowserZone(runtimeTimeZone()), []);

  async function save(patch: PreferencesPatch) {
    const previous = prefs;
    setPrefs({ ...prefs, ...patch });
    setState({ kind: "saving" });
    try {
      const res = await fetch("/api/me/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = (await res.json()) as Preferences | { error?: string };
      if (!res.ok) {
        setPrefs(previous);
        setState({
          kind: "error",
          message: ("error" in body && body.error) || "Could not save that preference.",
        });
        return;
      }
      setPrefs(body as Preferences);
      setState({ kind: "saved" });
      if ("timeZone" in patch || "clock" in patch) router.refresh();
    } catch {
      setPrefs(previous);
      setState({
        kind: "error",
        message: "Could not reach the server. Nothing was saved.",
      });
    }
  }

  const startOptions: SelectOption[] = [
    { value: "dashboards", label: "Dashboards list" },
    { value: "explore", label: "Explore" },
    ...dashboards.map((d) => ({
      value: `dashboard:${d.id}`,
      label: `${d.title} (${d.workspaceId})`,
    })),
  ];
  // A start dashboard that is no longer listed still shows as chosen, so the
  // control does not claim the list is the start page when it is not.
  if (!startOptions.some((o) => o.value === prefs.startPage)) {
    startOptions.push({
      value: prefs.startPage,
      label: "A dashboard you can no longer open",
    });
  }

  const example = formatDateTime(
    new Date(),
    { timeZone: prefs.timeZone, clock: prefs.clock },
    {
      seconds: true,
      year: true,
    },
  );

  return (
    <div className="flex flex-col gap-6">
      <p role="status" className="min-h-5 text-sm">
        {state.kind === "saving" && <span className="text-muted">Saving…</span>}
        {state.kind === "saved" && (
          <span className="text-success">Saved to your account.</span>
        )}
        {state.kind === "error" && <span className="text-danger">{state.message}</span>}
      </p>

      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-[12rem_1fr] sm:items-center">
          <Label className="mb-0" htmlFor="pref-start">
            Start page
          </Label>
          <Select
            id="pref-start"
            value={prefs.startPage}
            options={startOptions}
            onValueChange={(v) => void save({ startPage: v as Preferences["startPage"] })}
          />
          <Label className="mb-0" htmlFor="pref-sort">
            Dashboard list order
          </Label>
          <Select
            id="pref-sort"
            value={prefs.dashboardSort}
            options={SORT_OPTIONS}
            onValueChange={(v) =>
              void save({ dashboardSort: v as Preferences["dashboardSort"] })
            }
          />
          <span className="text-sm">Dashboard list shows</span>
          <Checkbox
            checked={prefs.favoritesOnly}
            onCheckedChange={(checked) => void save({ favoritesOnly: checked })}
            label="Only my favorites"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Date and time</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-[12rem_1fr] sm:items-center">
          <Label className="mb-0" htmlFor="pref-zone">
            Time zone
          </Label>
          <Select
            id="pref-zone"
            value={prefs.timeZone}
            options={zones}
            onValueChange={(v) => void save({ timeZone: v })}
          />
          <Label className="mb-0" htmlFor="pref-clock">
            Clock
          </Label>
          <Select
            id="pref-clock"
            value={prefs.clock}
            options={CLOCK_OPTIONS}
            onValueChange={(v) => void save({ clock: v as Preferences["clock"] })}
          />
          <span className="text-sm text-muted">Example</span>
          <span className="text-sm" suppressHydrationWarning>
            {example}
            {prefs.timeZone === "local" && browserZone && (
              <span className="text-muted"> ({browserZone})</span>
            )}
          </span>
        </CardContent>
      </Card>
      <p className="text-xs text-muted">
        These follow you to any device you sign in on. Every time is still stored in UTC,
        and the server still decides which window each chart queries.
      </p>
    </div>
  );
}
