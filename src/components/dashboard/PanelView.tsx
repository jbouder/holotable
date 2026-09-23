"use client";

import * as React from "react";
import { Info } from "lucide-react";
import type { Panel, TimeRange } from "@/lib/ir";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorDisplay } from "@/components/ui/error-display";
import { EChart, type EChartHandle } from "@/components/charts/EChart";
import { PanelSqlDialog } from "@/components/dashboard/PanelSqlDialog";
import { PanelActions } from "@/components/dashboard/PanelActions";
import { LoadingLabel, PanelSkeleton } from "@/components/dashboard/PanelSkeleton";
import { Popover } from "@/components/ui/popover";
import { buildChartOption, type PanelData } from "@/components/charts/options";
import { formatClockTime } from "@/lib/connection";
import { useTimeDisplay } from "@/components/time-display";
import type { ApiError } from "@/lib/errors";
import { formatValue } from "@/lib/format";
import { PANEL_EXIT_SHORTCUT } from "@/lib/shortcuts";
import { supportsImageExport } from "@/lib/panel-export";
import { brushedRange, supportsTimeBrush } from "@/lib/time-range";
import { cn } from "@/lib/utils";

export type PanelStatus = "loading" | "live" | "stale" | "error" | "tombstoned";

export interface PanelState {
  data: PanelData;
  status: PanelStatus;
  error?: ApiError;
  /**
   * When this panel's data last arrived. Panels go stale independently — one
   * failing query does not stop the others — so the dashboard-wide "updated Ns
   * ago" is not the answer for any individual panel.
   */
  updatedAt?: number;
}

const EMPTY: PanelData = { columns: [], rows: [] };

export function PanelView({
  panel,
  state,
  onRetry,
  paused = false,
  timeRange,
  dashboardTitle,
  crosshairGroup,
  onSelectTimeRange,
}: {
  panel: Panel;
  state?: PanelState;
  onRetry?: () => void;
  paused?: boolean;
  /**
   * The window this panel is being shown for. Only the details dialog uses it,
   * to ask the server what it would run (#110); a surface that does not know
   * its window simply does not offer that.
   */
  timeRange?: TimeRange;
  /** Names the export file. A surface without one exports by panel title alone. */
  dashboardTitle?: string;
  /** Panels sharing this name move their axis pointer together. */
  crosshairGroup?: string;
  /**
   * Called with the window a brush across this panel selected. A surface that
   * does not own a time range simply does not pass it, and the panel is not
   * brushable.
   */
  onSelectTimeRange?: (range: TimeRange) => void;
}) {
  const data = state?.data ?? EMPTY;
  const status = state?.status ?? "loading";
  const chart = React.useRef<EChartHandle | null>(null);
  const expansion = useExpanded();

  // While paused, suppress the transient "live"/"loading" badges — they no
  // longer reflect reality. Error/tombstoned states remain meaningful.
  const showBadge = !(paused && (status === "live" || status === "loading"));

  return (
    <>
      {/*
        A backdrop, not a portal. Expanding moves nothing in the React tree —
        the same `<Card>` simply becomes `fixed` — which is what keeps the
        ECharts instance alive across it: the container node is never
        unmounted, so the chart is resized by the `ResizeObserver` already in
        `EChart` rather than disposed and rebuilt (invariant 11).
      */}
      {expansion.expanded && (
        <div
          className="fixed inset-0 z-40 bg-black/70"
          onClick={expansion.collapse}
          aria-hidden
        />
      )}
      <Card
        ref={expansion.ref}
        tabIndex={expansion.expanded ? -1 : undefined}
        role={expansion.expanded ? "dialog" : undefined}
        aria-modal={expansion.expanded ? true : undefined}
        aria-label={expansion.expanded ? `${panel.title}, fullscreen` : undefined}
        onKeyDown={expansion.onKeyDown}
        className={cn(
          "flex h-full flex-col",
          status === "stale" && "opacity-60",
          expansion.expanded && "fixed inset-3 z-50 h-auto sm:inset-8",
        )}
      >
        <CardHeader>
          <CardTitle className="min-w-0 truncate">{panel.title}</CardTitle>
          <div className="flex shrink-0 items-center gap-1">
            {showBadge && <StatusBadge status={status} updatedAt={state?.updatedAt} />}
            <PanelDescription panel={panel} />
            <PanelSqlDialog panel={panel} timeRange={timeRange} />
            <PanelActions
              panelTitle={panel.title}
              dashboardTitle={dashboardTitle}
              data={data}
              chart={supportsImageExport(panel.viz) ? chart : undefined}
              expanded={expansion.expanded}
              onToggleExpanded={expansion.toggle}
            />
          </div>
        </CardHeader>
        <CardContent className="flex-1 min-h-0">
          <PanelBody
            panel={panel}
            data={data}
            state={state}
            onRetry={onRetry}
            chartRef={chart}
            crosshairGroup={crosshairGroup}
            onSelectTimeRange={onSelectTimeRange}
          />
        </CardContent>
      </Card>
    </>
  );
}

/**
 * Fullscreen as a piece of state, with the keyboard contract that makes it a
 * dialog rather than a big card: Escape closes it, and focus goes into the
 * panel on the way in and back to whatever opened it on the way out.
 */
function useExpanded() {
  const [expanded, setExpanded] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const opener = React.useRef<Element | null>(null);

  React.useEffect(() => {
    if (!expanded) return;
    ref.current?.focus();
    // Escape is handled on the document as well as on the card: the menu that
    // opened fullscreen closes on its own Escape, and the focus may be
    // anywhere inside by the time the next one arrives.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === PANEL_EXIT_SHORTCUT.key) setExpanded(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [expanded]);

  const collapse = React.useCallback(() => setExpanded(false), []);

  return {
    expanded,
    ref,
    collapse,
    toggle: () =>
      setExpanded((was) => {
        if (was) {
          // Returning focus is the half of "Esc closes it" that is easy to
          // forget and impossible to work around with a keyboard.
          (opener.current as HTMLElement | null)?.focus?.();
          return false;
        }
        opener.current = document.activeElement;
        return true;
      }),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === PANEL_EXIT_SHORTCUT.key) setExpanded(false);
    },
  };
}

/**
 * What the panel computes, on demand (#106).
 *
 * `Panel.description` is optional and always has been, so a panel without one
 * renders exactly as it did — no icon, no placeholder. It says intent, never a
 * value: the model that wrote it has not seen the data.
 */
function PanelDescription({ panel }: { panel: Panel }) {
  if (!panel.description) return null;
  return (
    <Popover
      label={`What "${panel.title}" computes`}
      trigger={<Info className="h-4 w-4" />}
    >
      {panel.description}
    </Popover>
  );
}

function PanelBody({
  panel,
  data,
  state,
  onRetry,
  chartRef,
  crosshairGroup,
  onSelectTimeRange,
}: {
  panel: Panel;
  data: PanelData;
  state?: PanelState;
  onRetry?: () => void;
  /** Forwarded to the chart so the PNG export can reach it. */
  chartRef?: React.RefObject<EChartHandle | null>;
  crosshairGroup?: string;
  onSelectTimeRange?: (range: TimeRange) => void;
}) {
  const display = useTimeDisplay();
  if (state?.status === "tombstoned") {
    // A tombstone is the `conflict` kind: the source is gone, and the fix is to
    // repoint the panel. Routing it through ErrorDisplay is what gets it that
    // guidance instead of a bare sentence.
    return (
      <ErrorDisplay
        layout="block"
        error={{
          error: "This panel's data source has been removed.",
          kind: "conflict",
        }}
      />
    );
  }
  if (state?.status === "error") {
    return (
      <ErrorDisplay
        layout="block"
        error={state.error ?? { error: "Query failed", kind: "statement" }}
        onRetry={onRetry}
      />
    );
  }
  if (data.rows.length === 0 && (!state || state.status === "loading")) {
    // A skeleton in the panel's own shape rather than a centred spinner: the
    // panel already occupies its final grid cell, and filling it with the
    // silhouette of what is coming is what stops the page moving when the
    // rows land (#72).
    return (
      <>
        <PanelSkeleton viz={panel.viz} />
        <LoadingLabel>Loading {panel.title}…</LoadingLabel>
      </>
    );
  }

  switch (panel.viz) {
    case "stat":
      return <StatView panel={panel} data={data} />;
    case "table":
      return <TableView data={data} />;
    default:
      return (
        <EChart
          ref={chartRef}
          option={buildChartOption(panel, data, display)}
          crosshairGroup={crosshairGroup}
          onBrush={
            onSelectTimeRange && supportsTimeBrush(panel)
              ? ({ startIndex, endIndex }) => {
                  // A brush names a stretch of history, and the rows behind
                  // the chart are what give the indices a meaning. An
                  // unreadable selection — a gap in the data, a timestamp the
                  // driver serialized as something unexpected — leaves the
                  // window alone rather than guessing at one.
                  const range = brushedRange(
                    data.rows,
                    panel.query.timeField,
                    startIndex,
                    endIndex,
                  );
                  if (range) onSelectTimeRange(range);
                }
              : undefined
          }
        />
      );
  }
}

function StatView({ panel, data }: { panel: Panel; data: PanelData }) {
  const last = data.rows[data.rows.length - 1];
  const valueKey =
    data.columns.find(
      (c) => c !== panel.query.timeField && typeof last?.[c] === "number",
    ) ?? data.columns[data.columns.length - 1];
  const value = last?.[valueKey];
  return (
    <div className="flex h-full items-center justify-center">
      {/* Shrinks with the viewport: a 4xl number is most of a phone panel. */}
      <span className="text-3xl font-semibold tabular-nums sm:text-4xl">
        {value === undefined ? "—" : formatValue(value, panel.format)}
      </span>
    </div>
  );
}

/**
 * The first column is sticky and the table scrolls sideways under it, so a
 * narrow screen keeps the label of the row it is reading (#78). `w-max` rather
 * than `w-full`: the table is allowed to be wider than the panel — that is
 * what gives it something to scroll — and stretches to fill when it is not.
 */
function TableView({ data }: { data: PanelData }) {
  return (
    <div className="max-h-full overflow-auto">
      <table className="w-max min-w-full text-left text-sm">
        <thead className="sticky top-0 z-10 bg-surface-2 text-muted">
          <tr>
            {data.columns.map((c, i) => (
              <th
                key={c}
                className={cn(
                  "px-2 py-1 font-medium",
                  i === 0 && "sticky left-0 z-10 bg-surface-2",
                )}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.slice(-100).map((r, i) => (
            // Query result rows carry no stable identity, and the table is
            // render-only — nothing is reordered, edited or keyed off state.
            // biome-ignore lint/suspicious/noArrayIndexKey: result rows have no id
            <tr key={i} className="border-t border-border">
              {data.columns.map((c, col) => (
                <td
                  key={c}
                  className={cn(
                    "px-2 py-1 tabular-nums",
                    col === 0 && "sticky left-0 bg-surface",
                  )}
                >
                  {String(r[c] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STATUS_STYLES: Record<PanelStatus, string> = {
  loading: "bg-surface-2 text-muted",
  live: "bg-success/20 text-success",
  stale: "bg-surface-2 text-muted",
  error: "bg-danger/20 text-danger",
  tombstoned: "bg-danger/20 text-danger",
};

/**
 * The badge doubles as the panel's freshness readout: an absolute clock time in
 * the tooltip rather than a relative one, so it stays correct without a timer
 * re-rendering every panel and every chart once a second. The dashboard header
 * is where the live-counting "Ns ago" belongs.
 */
function StatusBadge({ status, updatedAt }: { status: PanelStatus; updatedAt?: number }) {
  const display = useTimeDisplay();
  const freshness =
    updatedAt === undefined
      ? "No data yet"
      : `Updated at ${formatClockTime(updatedAt, display)}`;
  return (
    <span
      title={freshness}
      className={cn(
        // Below `sm` the header has room for the title and the actions and
        // nothing else, so the badge steps aside visually and stays readable
        // to a screen reader (#78).
        "px-2 py-0.5 text-xs font-medium capitalize max-sm:sr-only",
        STATUS_STYLES[status],
      )}
    >
      {status}
      {/* The tooltip is mouse-only; this is the same fact for everyone else. */}
      <span className="sr-only">. {freshness}</span>
    </span>
  );
}
