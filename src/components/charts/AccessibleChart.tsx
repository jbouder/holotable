"use client";

import type * as React from "react";
import { EChart } from "@/components/charts/EChart";
import { normalize, type PanelData } from "@/components/charts/options";
import {
  DatumLinksControl,
  DatumLinksPopover,
  useDatumClick,
  useDatumLinks,
} from "@/components/dashboard/DatumLinks";
import { datumOf, datumOfRow } from "@/lib/drilldown-datum";
import { useTimeDisplay } from "@/components/time-display";
import type { Panel } from "@/lib/ir";
import type { Datum } from "@/lib/drilldown";
import { type ChartRows, chartDescription, chartTable } from "@/lib/panel-reading";
import type { TimeDisplay } from "@/lib/time-display";
import { cn } from "@/lib/utils";

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
  table: readTable,
  ...chart
}: {
  panel: Panel;
  data: PanelData;
  /** The kind's own table, where its marks are not one per row (#623). */
  table?: (panel: Panel, data: PanelData, display: TimeDisplay) => ChartRows;
} & Omit<React.ComponentProps<typeof EChart>, "description">) {
  const display = useTimeDisplay();
  const own = readTable?.(panel, data, display);
  const table = own ?? chartTable(panel, data, display);
  // Datum links (#373): a click on a point follows them, and each row of the
  // table below offers the same, so a keyboard reaches whatever a mouse can.
  const links = useDatumLinks();
  const [choice, onDatum, close] = useDatumClick(links);
  // The table lists the newest rows; this is where they start among them all.
  const offset = normalize(data).rows.length - table.rows.length;
  return (
    // `fade-in`: the chart arrives with its chunk (#497), after the panel's
    // skeleton, and enters the way an overlay does rather than popping in.
    <div className="fade-in relative h-full w-full">
      <EChart
        {...chart}
        description={chartDescription(panel, data.rows.length)}
        onDatum={
          links
            ? (click) =>
                onDatum(
                  datumOf(panel, data, click, links.window),
                  click.clientX,
                  click.clientY,
                )
            : undefined
        }
      />
      {links && (
        <DatumLinksPopover
          choice={choice}
          onClose={close}
          label={`Links from ${panel.title}`}
        />
      )}
      {table.rows.length > 0 && (
        // Hidden until a keyboard tabs into its links, when it shows over the
        // chart: a focused control must be visible (WCAG 2.4.7). The box is a
        // div because a table ignores `sr-only`'s one-pixel width, and a wide
        // one made the page scroll sideways (#536).
        <div
          className={cn(
            "sr-only",
            links &&
              "focus-within:not-sr-only focus-within:absolute focus-within:inset-0 focus-within:z-10 focus-within:overflow-auto focus-within:bg-surface focus-within:text-left focus-within:text-sm",
          )}
        >
          <table>
            <caption>{table.caption}</caption>
            <thead>
              <tr>
                {table.columns.map((c) => (
                  <th key={c} scope="col">
                    {c}
                  </th>
                ))}
                {links && (
                  <th scope="col">
                    <span className="sr-only">Links</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, i) => (
                // Result rows have no identity, and this table is render-only.
                // biome-ignore lint/suspicious/noArrayIndexKey: result rows have no id
                <tr key={i}>
                  {row.map((cell, j) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
                    <td key={j} className="px-2 py-1">
                      {cell}
                    </td>
                  ))}
                  {links && (
                    <td>
                      <RowLinks
                        panel={panel}
                        data={data}
                        index={offset + i}
                        datum={own?.datums[i]}
                        label={own?.labels?.[i] ?? row[0] ?? ""}
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RowLinks({
  panel,
  data,
  index,
  datum: own,
  label,
}: {
  panel: Panel;
  data: PanelData;
  index: number;
  /** The row's datum, when the kind's own table says it (#623). */
  datum?: Datum | null;
  label: string;
}) {
  const datum = own !== undefined ? own : datumOfRow(panel, data, index);
  return datum ? <DatumLinksControl datum={datum} label={label || panel.title} /> : null;
}
