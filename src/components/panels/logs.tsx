"use client";

import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronRight } from "lucide-react";
import * as React from "react";
import { DatumLinksControl, useDatumLinks } from "@/components/dashboard/DatumLinks";
import type { PanelBodyProps } from "@/components/panels/types";
import { useTimeDisplay } from "@/components/time-display";
import { tokenCss } from "@/lib/panels/colors";
import { LogsOptions } from "@/lib/panels/kinds/logs";
import { readOptions } from "@/lib/panels/presentation";
import { type LogLine, logLines } from "@/lib/panel-reading";
import { cn } from "@/lib/utils";
import { useVirtualRows } from "@/components/ui/virtual-rows";

/** A line's height before it is measured: one line of `text-xs` and its padding. */
const LINE_ESTIMATE = 25;

/**
 * Log lines (#404): a time, a level and a message per line, in a monospace
 * list. A line with other columns is a disclosure (Base UI's Collapsible, the
 * one sanctioned height transition) over them; a datum link sits at its end.
 *
 * The list is a stream, so it neither staggers nor FLIPs. A reader who has
 * scrolled down keeps their place: the first line in view is remembered on
 * every scroll, and after a poll the list is scrolled so that line sits where
 * it was, whatever arrived above it or fell off the end. A reader at the top
 * sees the new lines arrive.
 */
export function LogsView({ panel, data }: PanelBodyProps) {
  const display = useTimeDisplay();
  const { lines, overflow } = React.useMemo(
    () => logLines(panel, data, display),
    [panel, data, display],
  );
  const o = readOptions(LogsOptions, panel.options);
  const links = useDatumLinks();
  const scroller = React.useRef<HTMLElement>(null);
  /** The first line in view, and how far below the top of the view it sits. */
  const anchor = React.useRef<{ key: string; offset: number } | null>(null);
  const first = lines[0]?.key;
  // Windowed (#499): every line the panel was sent, a screenful of them in
  // the DOM. Positions come from measured heights, so the anchor below works
  // for a line that is not drawn.
  const keys = React.useMemo(() => lines.map((l) => l.key), [lines]);
  const rows = useVirtualRows({ scrollRef: scroller, keys, estimate: LINE_ESTIMATE });
  const { indexAt, offsetOf, refresh } = rows;

  const remember = React.useCallback(() => {
    const el = scroller.current;
    if (!el || el.scrollTop === 0 || keys.length === 0) {
      anchor.current = null;
      return;
    }
    const index = indexAt(el.scrollTop);
    anchor.current = { key: keys[index], offset: offsetOf(index) - el.scrollTop };
  }, [keys, indexAt, offsetOf]);

  // `first` changes when a poll brings lines in above the reader.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the newest line changes
  React.useLayoutEffect(() => {
    const el = scroller.current;
    const held = anchor.current;
    if (!el || !held) return;
    const index = keys.indexOf(held.key);
    if (index >= 0) el.scrollTop = offsetOf(index) - held.offset;
    refresh();
    remember();
  }, [first]);

  return (
    <section
      ref={scroller}
      onScroll={remember}
      aria-label={`${panel.title}, log`}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container must be focusable to scroll by keyboard (WCAG 2.1.1)
      tabIndex={0}
      // `relative`, so each line's offsetTop is measured from the list.
      // No browser scroll anchoring (#499): the spacers around the window
      // change size as it moves; the reader's place is kept above, by hand.
      // `@container`: a line's layout follows the panel's width, not the
      // viewport's (#644), since a panel is often narrow on a wide screen.
      className="@container relative max-h-full overflow-auto font-mono text-xs [overflow-anchor:none] focus-visible:outline-2 focus-visible:outline-ring"
    >
      {lines.length === 0 ? (
        <p className="p-2 text-muted">No lines in this window.</p>
      ) : (
        <ol
          className="divide-y divide-border"
          // The lines not drawn, as space, so the scrollbar is the whole log's.
          style={{ paddingTop: rows.before, paddingBottom: rows.after }}
        >
          {lines.slice(rows.start, rows.end).map((line) => (
            <li
              key={line.key}
              ref={rows.measure}
              data-vkey={line.key}
              data-line={line.key}
              className="flex items-start gap-1"
            >
              <Line line={line} wrap={o.wrap !== false} showTime={o.showTime !== false} />
              {links && (
                <DatumLinksControl
                  datum={{ row: line.row, series: line.level }}
                  label={line.message || panel.title}
                />
              )}
            </li>
          ))}
        </ol>
      )}
      {overflow > 0 && (
        <p className="p-2 text-muted">
          {overflow} older lines not shown. Narrow the query to see them.
        </p>
      )}
    </section>
  );
}

function Line({
  line,
  wrap,
  showTime,
}: {
  line: LogLine;
  wrap: boolean;
  showTime: boolean;
}) {
  const stripe = line.color ? { borderLeftColor: tokenCss(line.color) } : undefined;
  const text = (
    <>
      {/* The clock alone in a panel too narrow for the date; the full time is in the details. */}
      {showTime && line.time && (
        <>
          <span className="shrink-0 tabular-nums text-muted @2xs:hidden">
            {line.clock}
          </span>
          <span className="hidden shrink-0 tabular-nums text-muted @2xs:inline">
            {line.time}
          </span>
        </>
      )}
      {line.level && (
        <span className="w-12 shrink-0 font-semibold uppercase text-foreground">
          {line.level}
        </span>
      )}
      {/* Under the time and level in a narrow panel, beside them in a wide one. */}
      <span
        className={cn(
          "min-w-0 basis-full text-foreground @md:basis-0 @md:flex-1",
          wrap ? "break-words whitespace-pre-wrap" : "truncate",
        )}
      >
        {line.message}
      </span>
    </>
  );
  const row =
    "flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 border-l-2 border-transparent px-2 py-1 @md:flex-nowrap";
  if (line.details.length === 0) {
    return (
      <div className={cn(row, "pl-6")} style={stripe}>
        {text}
      </div>
    );
  }
  return (
    <Collapsible.Root className="min-w-0 flex-1">
      <Collapsible.Trigger
        className={cn(
          row,
          "group w-full cursor-pointer text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring",
        )}
        style={stripe}
      >
        <ChevronRight
          aria-hidden
          className="h-3 w-3 shrink-0 self-center text-muted transition-transform duration-(--duration-fast) ease-standard group-data-[panel-open]:rotate-90"
        />
        {text}
      </Collapsible.Trigger>
      <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height,opacity] duration-(--duration-base) ease-emphasized data-starting-style:h-0 data-starting-style:opacity-0 data-ending-style:h-0 data-ending-style:opacity-0">
        <dl className="grid grid-cols-1 gap-x-3 gap-y-0.5 bg-surface-2 py-1.5 pr-2 pl-6 @2xs:grid-cols-[max-content_1fr] @2xs:pl-8">
          {showTime && line.time && (
            <>
              <dt className="text-muted @2xs:hidden">time</dt>
              <dd className="min-w-0 break-words text-foreground @2xs:hidden">
                {line.time}
              </dd>
            </>
          )}
          {line.details.map(([name, value]) => (
            <React.Fragment key={name}>
              <dt className="text-muted">{name}</dt>
              <dd className="min-w-0 break-words text-foreground">{value}</dd>
            </React.Fragment>
          ))}
        </dl>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
