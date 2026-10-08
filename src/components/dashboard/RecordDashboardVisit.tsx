"use client";

import * as React from "react";
import { readRecent, recordVisit, writeRecent } from "@/lib/dashboard-list";
import { useHistoryPreferences } from "@/components/history-preferences";

/**
 * Remember that this browser opened this dashboard.
 *
 * Renders nothing. It exists because the alternative — recording every view
 * server-side — means writing a row per page load to answer a question only
 * the person who did the viewing ever asks. Ids only: the titles are resolved
 * later through the ordinary authorized list endpoint, so an id kept here
 * grants nothing and a dashboard the reader loses access to simply stops
 * coming back. Nothing is recorded with the Recent row turned off in
 * Preferences.
 */
export function RecordDashboardVisit({ dashboardId }: { dashboardId: string }) {
  const { recentDashboards: enabled } = useHistoryPreferences();
  React.useEffect(() => {
    if (!enabled) return;
    const storage = typeof window === "undefined" ? undefined : window.localStorage;
    writeRecent(storage, recordVisit(readRecent(storage), dashboardId));
  }, [dashboardId, enabled]);

  return null;
}
