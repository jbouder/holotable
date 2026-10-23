"use client";

import * as React from "react";
import {
  type ChartTheme,
  DEFAULT_CHART_THEME,
  FORCED_COLORS_QUERY,
  forcedColorsTheme,
  readChartTheme,
} from "@/lib/color/chart-theme";
import { resolveColor } from "@/lib/color/oklch";

/** A system color keyword as this browser resolves it, through a probe. */
function systemColor(keyword: string): string {
  const probe = document.createElement("span");
  probe.style.color = keyword;
  probe.style.display = "none";
  document.body.append(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return resolveColor(value);
}

const read = () => {
  const page = readChartTheme(getComputedStyle(document.documentElement));
  return window.matchMedia(FORCED_COLORS_QUERY).matches
    ? forcedColorsTheme(systemColor, page)
    : page;
};

/**
 * The page's colors for a chart's chrome, following the theme (#502).
 *
 * Read from `<html>` on first render — the bootstrap script has already put
 * `data-theme` there, so the first option a chart builds is the page's — and
 * again whenever `data-theme` changes, which is the one place the toggle, the
 * command palette, Settings and an OS change all arrive. A new value rebuilds
 * the option and the chart merges it in; nothing is recreated. Under the
 * operating system's forced colors it draws in the system colors instead, and
 * re-reads when that mode turns on or off (#506).
 */
export function useChartTheme(): ChartTheme {
  const [theme, setTheme] = React.useState<ChartTheme>(() =>
    typeof document === "undefined" ? DEFAULT_CHART_THEME : read(),
  );
  React.useEffect(() => {
    const html = document.documentElement;
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(html, {
      attributes: true,
      attributeFilter: ["data-theme", "data-palette"],
    });
    // Forced colors turning on or off, and, while on, a switch between the
    // system's contrast themes, which changes its colors but not the match.
    const queries = [FORCED_COLORS_QUERY, "(prefers-color-scheme: dark)"].map((q) =>
      window.matchMedia(q),
    );
    const onChange = () => setTheme(read());
    for (const q of queries) q.addEventListener("change", onChange);
    return () => {
      observer.disconnect();
      for (const q of queries) q.removeEventListener("change", onChange);
    };
  }, []);
  return theme;
}
