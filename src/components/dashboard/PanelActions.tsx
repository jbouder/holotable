"use client";

import type * as React from "react";
import { Download, Image as ImageIcon, Maximize2, Minimize2 } from "lucide-react";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/menu";
import type { EChartHandle } from "@/components/charts/EChart";
import {
  CSV_BOM,
  CSV_SCOPE_NOTE,
  type ExportableResult,
  exportFilename,
  toCsv,
} from "@/lib/panel-export";
import { resolveColor } from "@/lib/color/oklch";

/**
 * The per-panel overflow menu: enlarge it, or take what it holds out of the
 * browser (#76).
 *
 * Every action here is local. Nothing asks the server for anything, so an
 * export cannot contain a row the panel was not already showing and cannot
 * become a second, unguarded way to run a query — which is also why the CSV
 * item says out loud that it is the current window.
 */
export function PanelActions({
  panelTitle,
  dashboardTitle,
  data,
  chart,
  expanded,
  onToggleExpanded,
}: {
  panelTitle: string;
  dashboardTitle?: string;
  data: ExportableResult;
  /** The chart, when this panel has one. Stat and table panels offer CSV only. */
  chart?: React.RefObject<EChartHandle | null>;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const hasRows = data.columns.length > 0 && data.rows.length > 0;

  const name = (extension: "csv" | "png") =>
    exportFilename({ dashboard: dashboardTitle, panel: panelTitle, extension });

  function exportCsv() {
    const csv = toCsv(data);
    if (!csv) return;
    const blob = new Blob([CSV_BOM, csv], { type: "text/csv;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    download(href, name("csv"));
    URL.revokeObjectURL(href);
  }

  function exportPng() {
    // The canvas is transparent, so the theme's own surface colour is painted
    // behind it — an exported chart should look like the one on screen, not
    // like a dark-theme chart pasted onto white.
    const url = chart?.current?.toPng(surfaceColor());
    if (url) download(url, name("png"));
  }

  return (
    <Menu
      label={`Actions for ${panelTitle}`}
      trigger={
        expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />
      }
    >
      <MenuItem onClick={onToggleExpanded}>
        {expanded ? (
          <>
            <Minimize2 className="h-4 w-4" /> Exit fullscreen
          </>
        ) : (
          <>
            <Maximize2 className="h-4 w-4" /> Fullscreen
          </>
        )}
      </MenuItem>
      <MenuSeparator />
      <MenuItem onClick={exportCsv} disabled={!hasRows}>
        <Download className="h-4 w-4" />
        <span title={CSV_SCOPE_NOTE}>Export CSV</span>
      </MenuItem>
      {chart && (
        <MenuItem onClick={exportPng} disabled={!hasRows}>
          <ImageIcon className="h-4 w-4" /> Export PNG
        </MenuItem>
      )}
    </Menu>
  );
}

/** Click an anchor the browser never sees — the only way to name a download. */
function download(href: string, filename: string): void {
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

/**
 * The themed card background, resolved to something a canvas accepts.
 *
 * The token is authored in OKLCH, which `getDataURL` hands straight to the
 * canvas; `resolveColor` is the same conversion the chart palette already goes
 * through. The fallback is the dark theme's surface rather than white, because
 * a wrong guess should still be a readable picture.
 */
function surfaceColor(): string {
  const style = getComputedStyle(document.documentElement);
  // `--surface` is the token the light theme overrides on the same element, so
  // reading it here follows the theme; `--color-surface` is the Tailwind alias.
  const computed = (
    style.getPropertyValue("--surface") || style.getPropertyValue("--color-surface")
  ).trim();
  return computed ? resolveColor(computed) : "#111318";
}
