"use client";

import * as React from "react";
import type { PanelBodyProps } from "@/components/panels/types";
import { DatumLinksControl, useDatumLinks } from "@/components/dashboard/DatumLinks";
import { toText } from "@/components/charts/options";
import { tableView } from "@/lib/panel-reading";
import { cn } from "@/lib/utils";
import { useVirtualRows } from "@/components/ui/virtual-rows";

/** A row's height before it is measured: one line of `text-sm` and its padding. */
const ROW_ESTIMATE = 29;

const ALIGN = { left: "text-left", center: "text-center", right: "text-right" } as const;

/**
 * The first column is sticky and the table scrolls sideways under it, so a
 * narrow screen keeps the label of the row it is reading (#78). `w-max` rather
 * than `w-full`: the table is allowed to be wider than the panel — that is
 * what gives it something to scroll — and stretches to fill when it is not.
 *
 * Which columns, in what order, under what header and written how, and the
 * rows' order, are the panel's options (#115); without any it is the result
 * as it came.
 */
export function TableView({ panel, data }: PanelBodyProps) {
  const { columns, rows } = React.useMemo(() => tableView(panel, data), [panel, data]);
  // Windowed (#499): every row the panel was sent, a screenful of them in the
  // DOM. Result rows have no identity, so a row is its position.
  const scroller = React.useRef<HTMLElement>(null);
  const keys = React.useMemo(() => rows.map((_, i) => String(i)), [rows]);
  // Datum links (#373) sit in a trailing cell per row; the row itself stays
  // text to read and copy, not a click target.
  const links = useDatumLinks();
  const span = columns.length + (links ? 1 : 0);
  const { start, end, before, after, measure } = useVirtualRows({
    scrollRef: scroller,
    keys,
    estimate: ROW_ESTIMATE,
  });
  return (
    // Focusable, so a keyboard can scroll a table that overflows its panel;
    // named, so what took focus is announced (#77).
    <section
      ref={scroller}
      aria-label={`${panel.title}, table`}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container must be focusable to scroll by keyboard (WCAG 2.1.1)
      tabIndex={0}
      className="max-h-full overflow-auto focus-visible:outline-2 focus-visible:outline-primary"
    >
      {/* The whole count, so a screen reader says how many rows there are
          when only some are in the DOM. */}
      <table
        className="w-max min-w-full text-left text-sm"
        aria-rowcount={rows.length + 1}
      >
        <thead className="sticky top-0 z-10 bg-surface-2 text-muted">
          <tr aria-rowindex={1}>
            {columns.map((c, i) => (
              <th
                key={c.name}
                className={cn(
                  "px-2 py-1 font-medium",
                  c.align && ALIGN[c.align],
                  i === 0 && "sticky left-0 z-10 bg-surface-2",
                )}
                style={c.width ? { width: c.width, minWidth: c.width } : undefined}
              >
                {c.label}
              </th>
            ))}
            {links && (
              <th className="px-2 py-1">
                <span className="sr-only">Links</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {before > 0 && <Spacer height={before} span={span} />}
          {rows.slice(start, end).map((r, n) => {
            const i = start + n;
            return (
              // Query result rows carry no stable identity, and the table is
              // render-only — nothing is reordered, edited or keyed off state.
              <tr
                key={i}
                ref={measure}
                data-vkey={i}
                aria-rowindex={i + 2}
                className="border-t border-border"
              >
                {columns.map((c, col) => (
                  <td
                    key={c.name}
                    className={cn(
                      "px-2 py-1 tabular-nums",
                      c.align && ALIGN[c.align],
                      col === 0 && "sticky left-0 bg-surface",
                    )}
                  >
                    {c.text(r[c.name])}
                  </td>
                ))}
                {links && (
                  <td className="px-1 py-0.5 text-right">
                    <DatumLinksControl
                      datum={{ row: r }}
                      label={toText(r[columns[0]?.name ?? ""]) || panel.title}
                    />
                  </td>
                )}
              </tr>
            );
          })}
          {after > 0 && <Spacer height={after} span={span} />}
        </tbody>
      </table>
    </section>
  );
}

/** The rows not drawn, as space, so the scrollbar is the whole table's. */
function Spacer({ height, span }: { height: number; span: number }) {
  return (
    <tr aria-hidden style={{ height }}>
      <td colSpan={span} className="p-0" />
    </tr>
  );
}
