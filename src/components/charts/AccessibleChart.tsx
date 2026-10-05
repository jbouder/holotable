"use client";

import type * as React from "react";
import { EChart } from "@/components/charts/EChart";
import type { PanelData } from "@/components/charts/options";
import { useTimeDisplay } from "@/components/time-display";
import type { Panel } from "@/lib/ir";
import { chartDescription, chartTable } from "@/lib/panel-reading";

/**
 * A canvas chart with what a screen reader needs beside it (#77): an
 * accessible name on the chart, and the rows it draws as a visually hidden
 * table. Both come from the same `data` the chart is given, so neither can
 * say something the picture does not.
 *
 * The table is a sibling of the chart's container, not a child: ECharts owns
 * everything inside that element.
 */
export function AccessibleChart({
  panel,
  data,
  ...chart
}: { panel: Panel; data: PanelData } & Omit<
  React.ComponentProps<typeof EChart>,
  "description"
>) {
  const display = useTimeDisplay();
  const table = chartTable(panel, data, display);
  return (
    <>
      <EChart {...chart} description={chartDescription(panel, data.rows.length)} />
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
            {table.rows.map((row, i) => (
              // Result rows have no identity, and this table is render-only.
              // biome-ignore lint/suspicious/noArrayIndexKey: result rows have no id
              <tr key={i}>
                {row.map((cell, j) => (
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
