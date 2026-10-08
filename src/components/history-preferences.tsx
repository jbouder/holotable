"use client";

import * as React from "react";
import { type HistoryPreferences, KEEP_ALL_HISTORY } from "@/lib/preferences";

/**
 * Which recents this person keeps, handed down from the root layout, which
 * reads the preferences once per request. Every place that writes or shows a
 * recent asks this first, so "off" means nothing is recorded, not merely that
 * nothing is shown. Outside a provider (signed out, embeds) everything is on,
 * which is also where nothing records anyway.
 */
const HistoryPreferencesContext =
  React.createContext<HistoryPreferences>(KEEP_ALL_HISTORY);

export function HistoryPreferencesProvider({
  value,
  children,
}: {
  value: HistoryPreferences;
  children: React.ReactNode;
}) {
  // Stable while the preference is: consumers re-run their effects only when
  // a choice actually changes.
  const stable = React.useMemo(
    () => ({
      prompts: value.prompts,
      recentDashboards: value.recentDashboards,
      paletteHistory: value.paletteHistory,
    }),
    [value.prompts, value.recentDashboards, value.paletteHistory],
  );
  return (
    <HistoryPreferencesContext.Provider value={stable}>
      {children}
    </HistoryPreferencesContext.Provider>
  );
}

export function useHistoryPreferences(): HistoryPreferences {
  return React.useContext(HistoryPreferencesContext);
}
