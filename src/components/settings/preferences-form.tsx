"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/input";
import { Select, type SelectOption } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  historyTurnedOff,
  type Preferences,
  type PreferencesPatch,
} from "@/lib/preferences";
import {
  EXPLORE_REFRESH_CHOICES,
  EXPLORE_TIME_RANGES,
  type ExploreRefreshMs,
  type ExploreStartView,
  type ExploreTimeRange,
} from "@/lib/explore-defaults";
import { LOCAL_STORES } from "@/lib/local-data";
import { browserStorage } from "@/lib/browser-storage";
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

const TIME_RANGE_OPTIONS: SelectOption[] = EXPLORE_TIME_RANGES.map((r) => ({
  value: r.value,
  label: r.label,
}));

const REFRESH_OPTIONS: SelectOption[] = EXPLORE_REFRESH_CHOICES.map((c) => ({
  value: String(c.value),
  label: c.label,
}));

const START_VIEW_OPTIONS: SelectOption[] = [
  { value: "model", label: "As the model drew it" },
  { value: "table", label: "A table" },
];

/** The history switches, each with the local store it keeps. */
const HISTORY_SWITCHES: {
  key: "rememberPrompts" | "rememberRecentDashboards" | "rememberPaletteHistory";
  label: string;
  description: string;
}[] = [
  {
    key: "rememberPrompts",
    label: "Remember recent prompts",
    description:
      "Offered back in the prompt boxes, with the source you last generated a dashboard from.",
  },
  {
    key: "rememberRecentDashboards",
    label: "Remember recently viewed dashboards",
    description: "The Recent row at the top of the dashboard list.",
  },
  {
    key: "rememberPaletteHistory",
    label: "Remember command palette history",
    description: "The commands the palette lists first when nothing is typed.",
  },
];

const HISTORY_KEYS = HISTORY_SWITCHES.map((h) => h.key);

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
  const [confirmForgetChats, setConfirmForgetChats] = React.useState(false);
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
      // Turning a recent off also forgets what this browser already kept.
      // These stores clear by key alone; only drafts need the subject.
      const forget: string[] = historyTurnedOff(patch);
      for (const store of LOCAL_STORES.filter((s) => forget.includes(s.id))) {
        store.clear(browserStorage(), { userSub: "", now: Date.now() });
      }
      // The root layout hands times and history down once per request.
      if (
        "timeZone" in patch ||
        "clock" in patch ||
        HISTORY_KEYS.some((k) => k in patch)
      ) {
        router.refresh();
      }
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
    <div className="relative flex flex-col gap-6">
      {/*
        Out of the flow, in the band above the first card, so the section
        keeps the same spacing as every other and nothing shifts on save.
      */}
      <p role="status" className="absolute right-0 -top-6 h-6 text-sm leading-6">
        {state.kind === "saving" && <span className="fade-in text-muted">Saving…</span>}
        {state.kind === "saved" && (
          <span className="fade-in text-success">Saved to your account.</span>
        )}
        {state.kind === "error" && (
          <span className="fade-in text-danger">{state.message}</span>
        )}
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
      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {HISTORY_SWITCHES.map((h) => (
            <div key={h.key} className="space-y-1">
              <Checkbox
                checked={prefs[h.key]}
                onCheckedChange={(checked) => void save({ [h.key]: checked })}
                label={h.label}
              />
              <p className="pl-6 text-xs text-muted">{h.description}</p>
            </div>
          ))}
          <p className="text-xs text-muted">
            The lists themselves stay in this browser. Turning one off stops recording it
            on every device you sign in on, and clears it here.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Explore</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-[12rem_1fr] sm:items-center">
          <Label className="mb-0" htmlFor="pref-explore-range">
            Time range
          </Label>
          <Select
            id="pref-explore-range"
            value={prefs.exploreTimeRange}
            options={TIME_RANGE_OPTIONS}
            onValueChange={(v) => void save({ exploreTimeRange: v as ExploreTimeRange })}
          />
          <Label className="mb-0" htmlFor="pref-explore-refresh">
            Auto-refresh
          </Label>
          <Select
            id="pref-explore-refresh"
            value={String(prefs.exploreRefreshMs)}
            options={REFRESH_OPTIONS}
            onValueChange={(v) =>
              void save({ exploreRefreshMs: Number(v) as ExploreRefreshMs })
            }
          />
          <Label className="mb-0" htmlFor="pref-explore-view">
            Answers start as
          </Label>
          <Select
            id="pref-explore-view"
            value={prefs.exploreStartView}
            options={START_VIEW_OPTIONS}
            onValueChange={(v) => void save({ exploreStartView: v as ExploreStartView })}
          />
          <span className="text-sm">Session</span>
          <Checkbox
            checked={prefs.exploreKeepSession}
            onCheckedChange={(checked) => void save({ exploreKeepSession: checked })}
            label="Keep this tab's answers when the page reloads"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Chat</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-[12rem_1fr] sm:items-center">
          <Label className="mb-0" htmlFor="pref-chat-refresh">
            Live refresh
          </Label>
          <Select
            id="pref-chat-refresh"
            value={String(prefs.chatRefreshMs)}
            options={REFRESH_OPTIONS}
            onValueChange={(v) =>
              void save({ chatRefreshMs: Number(v) as ExploreRefreshMs })
            }
          />
          <span className="text-sm">Queries</span>
          <Checkbox
            checked={prefs.chatShowQueries}
            onCheckedChange={(checked) => void save({ chatShowQueries: checked })}
            label="Show every answer's queries open"
          />
          <span className="text-sm">Conversations</span>
          <div className="space-y-1">
            <Checkbox
              checked={prefs.rememberChats}
              onCheckedChange={(checked) =>
                checked ? void save({ rememberChats: true }) : setConfirmForgetChats(true)
              }
              label="Keep my conversations"
            />
            <p className="pl-6 text-xs text-muted">
              Kept on the server, readable only by you. Off, a conversation is gone when
              you leave the page.
            </p>
          </div>
        </CardContent>
      </Card>
      <ConfirmDialog
        open={confirmForgetChats}
        onOpenChange={setConfirmForgetChats}
        title="Stop keeping conversations?"
        confirmLabel="Stop and delete"
        danger
        onConfirm={() => void save({ rememberChats: false })}
      >
        Every conversation you have kept is deleted, and new ones are gone when you leave
        the page. This follows you to every device you sign in on.
      </ConfirmDialog>

      <p className="text-xs text-muted">
        These follow you to any device you sign in on. Every time is still stored in UTC,
        and the server still decides which window each chart queries.
      </p>
    </div>
  );
}
