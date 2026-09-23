"use client";

import * as React from "react";
import {
  formatDateTime,
  LOCAL_TIME_DISPLAY,
  runtimeTimeZone,
  type TimeDisplay,
  zoneBadge,
} from "@/lib/time-display";

const TimeDisplayContext = React.createContext<TimeDisplay>(LOCAL_TIME_DISPLAY);

/**
 * The signed-in person's time display preference (#214), read once on the
 * server by the root layout and handed to every client component below it.
 * Signed out, or before a preference is saved, it is browser-local time.
 */
export function TimeDisplayProvider({
  value,
  children,
}: {
  value: TimeDisplay;
  children: React.ReactNode;
}) {
  const stable = React.useMemo(
    () => ({ timeZone: value.timeZone, clock: value.clock }),
    [value.timeZone, value.clock],
  );
  return (
    <TimeDisplayContext.Provider value={stable}>{children}</TimeDisplayContext.Provider>
  );
}

/** How times should be shown here. The one hook every timestamp goes through. */
export function useTimeDisplay(): TimeDisplay {
  return React.useContext(TimeDisplayContext);
}

/**
 * An instant as text on the person's clock, in a `<time>` element.
 *
 * The server renders it in *its* zone when the preference is browser-local,
 * so the text can legitimately differ from the browser's on hydration; that
 * one mismatch is expected and suppressed rather than papered over with an
 * empty first render.
 */
export function LocalTime({ iso, seconds }: { iso: string; seconds?: boolean }) {
  const display = useTimeDisplay();
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return <>{iso}</>;
  return (
    <time dateTime={iso} suppressHydrationWarning>
      {formatDateTime(date, display, { seconds, year: true })}
    </time>
  );
}

/**
 * The chosen zone's name when it is not the browser's own, for a label beside
 * a time control. Resolved after mount: the server cannot know the browser's
 * zone, so it renders nothing and the client fills it in.
 */
export function useZoneBadge(): string | null {
  const display = useTimeDisplay();
  const [badge, setBadge] = React.useState<string | null>(null);
  React.useEffect(() => {
    setBadge(zoneBadge(display, runtimeTimeZone()));
  }, [display]);
  return badge;
}
