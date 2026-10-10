"use client";

import * as React from "react";

interface ChartPatterns {
  on: boolean;
  set: (on: boolean) => void;
}

const ChartPatternsContext = React.createContext<ChartPatterns>({
  on: false,
  set: () => {},
});

/**
 * Whether charts fill their bars, slices and areas with patterns as well as
 * colors: the signed-in person's `chartPatterns` preference, read once by the
 * root layout and handed down like the time display. Off when signed out, in
 * an embed, and until the person turns it on. The settings control sets it
 * here as it saves, so every chart on the page follows without a reload.
 */
export function ChartPatternsProvider({
  value,
  children,
}: {
  value: boolean;
  children: React.ReactNode;
}) {
  const [on, setOn] = React.useState(value);
  // A new value from the server (another tab saved it) wins.
  React.useEffect(() => setOn(value), [value]);
  const context = React.useMemo(() => ({ on, set: setOn }), [on]);
  return (
    <ChartPatternsContext.Provider value={context}>
      {children}
    </ChartPatternsContext.Provider>
  );
}

/** Whether this person's charts carry patterns. */
export function useChartPatterns(): boolean {
  return React.useContext(ChartPatternsContext).on;
}

/** Set the preference for this page, after it has been saved. */
export function useSetChartPatterns(): (on: boolean) => void {
  return React.useContext(ChartPatternsContext).set;
}
