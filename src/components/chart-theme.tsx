"use client";

import * as React from "react";
import {
  type ChartTheme,
  DEFAULT_CHART_THEME,
  readChartTheme,
} from "@/lib/color/chart-theme";

const read = () => readChartTheme(getComputedStyle(document.documentElement));

/**
 * The page's colors for a chart's chrome, following the theme (#502).
 *
 * Read from `<html>` on first render — the bootstrap script has already put
 * `data-theme` there, so the first option a chart builds is the page's — and
 * again whenever `data-theme` changes, which is the one place the toggle, the
 * command palette, Settings and an OS change all arrive. A new value rebuilds
 * the option and the chart merges it in; nothing is recreated.
 */
export function useChartTheme(): ChartTheme {
  const [theme, setTheme] = React.useState<ChartTheme>(() =>
    typeof document === "undefined" ? DEFAULT_CHART_THEME : read(),
  );
  React.useEffect(() => {
    const html = document.documentElement;
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(html, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}
