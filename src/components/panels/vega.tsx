"use client";

import type { View } from "vega";
import type { Config } from "vega-lite";
import * as React from "react";
import type { PanelViewProps } from "@/components/panels/types";
import { useTimeDisplay } from "@/components/time-display";
import { ErrorDisplay } from "@/components/ui/error-display";
import { chartPalette, resolveColor } from "@/lib/color/oklch";
import { VegaOptions } from "@/lib/panels/kinds/vega";
import { readOptions } from "@/lib/panels/presentation";
import { chartDescription, chartTable } from "@/lib/panel-reading";
import { cn } from "@/lib/utils";
import { resolveVegaColors } from "@/lib/vega/colors";

/**
 * A custom visual (#405): a Vega-Lite spec drawn over the panel's rows.
 *
 * The view is built once per spec, behind the runtime's guards (no function
 * from a string, no network: `vega-runtime.ts`), and every poll is a
 * changeset into it, so data merges and the view is never rebuilt for it
 * (invariant 11). A changed spec builds a new view. Vega is loaded with the
 * first custom visual on a page and not before.
 *
 * Its theme is the page's: axis and legend text in `--muted` (which
 * `CONTRAST_PAIRS` holds to AA on every surface, in both themes), lines and
 * grid in `--border`, the chart palette for categories, a transparent
 * background, and every color the spec names resolved from the tokens. A
 * canvas cannot read a CSS variable, so they are read and converted when the
 * view is built, and the view is rebuilt when the theme changes. Like every
 * chart, it is an image to assistive technology, named by its title, with its
 * rows in a visually hidden table beside it.
 */

export interface VegaTheme {
  font: string;
  /** Axis, legend and header text. */
  text: string;
  /** Axis lines, ticks and grid. */
  line: string;
}

/** The theme as the page has it now: tokens read off `<html>` and converted. */
function pageTheme(el: HTMLElement): VegaTheme {
  const root = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) =>
    resolveColor(root.getPropertyValue(name).trim() || fallback);
  return {
    font: getComputedStyle(el).fontFamily,
    text: token("--muted", "#9aa0aa"),
    line: token("--border", "#3a3f4b"),
  };
}

export function vegaConfig({ font, text, line }: VegaTheme): Config {
  const axis = {
    labelColor: text,
    titleColor: text,
    domainColor: line,
    tickColor: line,
    gridColor: line,
    gridOpacity: 0.6,
    labelFont: font,
    titleFont: font,
  };
  return {
    background: "transparent",
    font,
    view: { stroke: "transparent" },
    axis,
    legend: { labelColor: text, titleColor: text, labelFont: font, titleFont: font },
    title: { color: text, font },
    header: { labelColor: text, titleColor: text, labelFont: font, titleFont: font },
    range: { category: chartPalette() },
    mark: { color: chartPalette()[0] },
    autosize: { type: "fit", contains: "padding" },
  } as Config;
}

/** A spec that draws one view takes the panel's size; a composed one keeps its own. */
function fitsContainer(spec: Record<string, unknown>): boolean {
  return !["facet", "repeat", "concat", "hconcat", "vconcat"].some((k) => k in spec);
}

export function VegaView({ panel, data, handle }: PanelViewProps) {
  const { spec } = readOptions(VegaOptions, panel.options);
  const key = JSON.stringify(spec ?? null);
  const composed = spec !== undefined && !fitsContainer(spec);
  const container = React.useRef<HTMLDivElement>(null);
  const view = React.useRef<View | null>(null);
  const rows = React.useRef(data.rows);
  rows.current = data.rows;
  const [error, setError] = React.useState<string | null>(null);
  const display = useTimeDisplay();
  // The theme lives on <html data-theme>; a change rebuilds the view in it.
  const [theme, setTheme] = React.useState<string | null>(null);
  React.useEffect(() => {
    const html = document.documentElement;
    const read = () => setTheme(html.getAttribute("data-theme"));
    read();
    const observer = new MutationObserver(read);
    observer.observe(html, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  // Build the view when the spec or the theme changes; tear it down when it goes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `theme` is read through the page's computed style
  React.useEffect(() => {
    const el = container.current;
    const parsed = JSON.parse(key) as Record<string, unknown> | null;
    if (!el || !parsed) return;
    let cancelled = false;
    let built: View | null = null;
    let resize: ResizeObserver | undefined;
    void (async () => {
      try {
        const [{ compileVegaLite }, { createVegaView }] = await Promise.all([
          import("@/lib/vega/compile"),
          import("@/components/charts/vega-runtime"),
        ]);
        const fits = fitsContainer(parsed);
        const sized = fits
          ? { ...parsed, width: el.clientWidth, height: el.clientHeight }
          : parsed;
        const compiled = await compileVegaLite(
          resolveVegaColors(sized),
          vegaConfig(pageTheme(el)),
        );
        if (!compiled.ok) throw new Error(compiled.error);
        built = await createVegaView(compiled.spec, rows.current, {
          container: el,
          renderer: "canvas",
        });
        if (cancelled) {
          built.finalize();
          return;
        }
        view.current = built;
        setError(null);
        if (fits) {
          resize = new ResizeObserver(() => {
            if (!built || el.clientWidth === 0) return;
            void built.width(el.clientWidth).height(el.clientHeight).runAsync();
          });
          resize.observe(el);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      resize?.disconnect();
      built?.finalize();
      view.current = null;
    };
  }, [key, theme]);

  // Every poll: the new rows, merged into the same view.
  React.useEffect(() => {
    const current = view.current;
    if (!current) return;
    void import("@/components/charts/vega-runtime").then(({ replaceVegaRows }) =>
      replaceVegaRows(current, data.rows),
    );
  }, [data.rows]);

  React.useImperativeHandle(
    handle,
    () => ({
      toPng: async (backgroundColor: string) => {
        const current = view.current;
        if (!current) return null;
        const before = current.background();
        current.background(backgroundColor);
        try {
          return await current.toImageURL(
            "png",
            Math.min(2, globalThis.devicePixelRatio || 1),
          );
        } finally {
          await current.background(before).runAsync();
        }
      },
    }),
    [],
  );

  if (error) {
    return (
      <ErrorDisplay
        layout="block"
        error={{
          error: `This custom visual could not be drawn: ${error}`,
          kind: "statement",
        }}
      />
    );
  }
  const table = chartTable(panel, data, display);
  return (
    <>
      {/*
        Named here, outside the element Vega draws into: Vega writes its own
        role and "Vega visualization" label onto that one, which is hidden
        from assistive technology, as an ECharts canvas is.
        `data-echarts-canvas` is what the axe scans exclude: the canvas has
        nothing to read, and the table beside it is scanned instead.
      */}
      <div
        role="img"
        aria-label={chartDescription(panel, data.rows.length)}
        data-echarts-canvas=""
        className="h-full w-full"
      >
        <div
          ref={container}
          aria-hidden="true"
          className={cn(
            "h-full w-full overflow-hidden",
            // A composed spec draws at its own size: scaled down to fit, never
            // cropped, keeping its aspect.
            composed &&
              "flex items-center justify-center [&_canvas]:h-auto! [&_canvas]:max-h-full [&_canvas]:w-auto! [&_canvas]:max-w-full",
          )}
        />
      </div>
      {table.rows.length > 0 && (
        <table className="sr-only">
          <caption>{table.caption}</caption>
          <thead>
            <tr>
              {table.columns.map((c) => (
                <th key={c} scope="col">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((cells, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: result rows have no id
              <tr key={i}>
                {cells.map((cell, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
                  <td key={j}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
