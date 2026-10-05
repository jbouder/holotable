"use client";

import * as React from "react";
import { Clock, Info } from "lucide-react";
import { hasQuery, type Panel, type TimeRange } from "@/lib/ir";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorDisplay } from "@/components/ui/error-display";
import { EChart, type EChartHandle } from "@/components/charts/EChart";
import { PanelSqlDialog } from "@/components/dashboard/PanelSqlDialog";
import { PanelActions } from "@/components/dashboard/PanelActions";
import { LoadingLabel, PanelSkeleton } from "@/components/dashboard/PanelSkeleton";
import { Popover } from "@/components/ui/popover";
import type { ChartContext, PanelData } from "@/components/charts/options";
import { panelRenderer } from "@/components/panels/registry";
import { formatClockTime } from "@/lib/connection";
import { useTimeDisplay } from "@/components/time-display";
import type { ApiError } from "@/lib/errors";
import { PANEL_EXIT_SHORTCUT } from "@/lib/shortcuts";
import { supportsImageExport } from "@/lib/panel-export";
import { brushedRange, panelOverride, supportsTimeBrush } from "@/lib/time-range";
import { cn } from "@/lib/utils";
import { type Box, DURATION_SLOW_MS, EASE_EMPHASIZED, flipFrom } from "@/lib/motion";
import { useReducedMotion } from "@/components/motion-preference";

export type PanelStatus =
  | "loading"
  | "live"
  | "stale"
  | "error"
  | "degraded"
  | "tombstoned";

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
  /**
   * A `degraded` panel (#44): how many times it has failed in a row, and when
   * the server tries it next. `retrying` is set while a viewer's "Retry now"
   * waits for the result, which replaces the whole state when it arrives.
   */
  failures?: number;
  retryAt?: number;
  retrying?: boolean;
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
  window,
}: {
  panel: Panel;
  state?: PanelState;
  onRetry?: () => void;
  paused?: boolean;
  /**
   * The window the server resolved for the rows, once it has said (epoch ms).
   * A chart that runs to "now" ends here (#201).
   */
  window?: ChartContext["window"];
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
  // A panel that runs no query (text, #202) has nothing to load or go stale.
  const queried = hasQuery(panel);
  const status = queried ? (state?.status ?? "loading") : "live";
  const chart = React.useRef<EChartHandle | null>(null);
  const expansion = useExpanded();

  // While paused, suppress the transient "live"/"loading" badges — they no
  // longer reflect reality. Error/tombstoned states remain meaningful. A text
  // panel has no status at all.
  const showBadge = queried && !(paused && (status === "live" || status === "loading"));

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
          className="fade-in fixed inset-0 z-40 bg-black/70"
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
          "flex h-full flex-col transition-opacity duration-(--duration-base) ease-standard",
          status === "stale" && "opacity-60",
          expansion.expanded && "fixed inset-3 z-50 h-auto sm:inset-8",
        )}
      >
        <CardHeader>
          <CardTitle className="min-w-0 truncate">{panel.title}</CardTitle>
          <div className="flex shrink-0 items-center gap-1">
            <OverrideBadge panel={panel} />
            {showBadge && <StatusBadge status={status} updatedAt={state?.updatedAt} />}
            <PanelDescription panel={panel} />
            <PanelSqlDialog panel={panel} timeRange={timeRange} />
            <PanelActions
              panelTitle={panel.title}
              dashboardTitle={dashboardTitle}
              data={data}
              exportable={queried}
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
            state={queried ? state : { data, status: "live" }}
            onRetry={onRetry}
            chartRef={chart}
            crosshairGroup={crosshairGroup}
            onSelectTimeRange={onSelectTimeRange}
            window={window}
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
 *
 * The card grows and shrinks between its two boxes rather than jumping
 * (#238): a single-element FLIP, measured here because `useFlip` only knows
 * position. The box is taken just before the state changes and compared in
 * a layout effect just after, and the difference is played back with WAAPI
 * on `translate` and `scale` only, so the chart inside is never remounted
 * and `EChart`'s `ResizeObserver` resizes it to the final box.
 */
function useExpanded() {
  const [expanded, setExpanded] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const opener = React.useRef<Element | null>(null);
  const motion = !useReducedMotion();
  /** The card's box from just before the last change, consumed by the layout effect. */
  const first = React.useRef<Box | null>(null);

  const change = React.useCallback(
    (next: boolean) => {
      first.current = motion && ref.current ? ref.current.getBoundingClientRect() : null;
      setExpanded(next);
    },
    [motion],
  );

  // `expanded` is not read in the body: the box recorded by `change` is what
  // matters, and this must run right after the render that changed it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate re-run trigger, not a read
  React.useLayoutEffect(() => {
    const el = ref.current;
    const from = first.current;
    first.current = null;
    if (!el || !from || typeof el.animate !== "function") return;
    const keyframe = flipFrom(from, el.getBoundingClientRect());
    if (!keyframe) return;
    el.animate(
      [
        { ...keyframe, transformOrigin: "0 0" },
        { translate: "0 0", scale: "1 1", transformOrigin: "0 0" },
      ],
      {
        duration: DURATION_SLOW_MS,
        easing: EASE_EMPHASIZED,
      },
    );
  }, [expanded]);

  React.useEffect(() => {
    if (!expanded) return;
    ref.current?.focus();
    // Escape is handled on the document as well as on the card: the menu that
    // opened fullscreen closes on its own Escape, and the focus may be
    // anywhere inside by the time the next one arrives.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === PANEL_EXIT_SHORTCUT.key) change(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [expanded, change]);

  const collapse = React.useCallback(() => change(false), [change]);

  return {
    expanded,
    ref,
    collapse,
    toggle: () => {
      if (expanded) {
        // Returning focus is the half of "Esc closes it" that is easy to
        // forget and impossible to work around with a keyboard.
        (opener.current as HTMLElement | null)?.focus?.();
        change(false);
        return;
      }
      opener.current = document.activeElement;
      change(true);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === PANEL_EXIT_SHORTCUT.key) change(false);
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
  window,
}: {
  panel: Panel;
  data: PanelData;
  state?: PanelState;
  onRetry?: () => void;
  /** Forwarded to the chart so the PNG export can reach it. */
  chartRef?: React.RefObject<EChartHandle | null>;
  crosshairGroup?: string;
  onSelectTimeRange?: (range: TimeRange) => void;
  window?: ChartContext["window"];
}) {
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
  if (state?.status === "degraded") {
    return <DegradedBody state={state} onRetry={onRetry} />;
  }
  if (
    hasQuery(panel) &&
    data.rows.length === 0 &&
    (!state || state.status === "loading")
  ) {
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

  // One wrapper for every content shape, so the first rows rise in over the
  // skeleton's place (#236). It mounts once, when the rows first land, and
  // stays: the chart inside is never remounted (invariant 11).
  return (
    <div className="stagger-in h-full min-h-0">
      <PanelContent
        panel={panel}
        data={data}
        chartRef={chartRef}
        crosshairGroup={crosshairGroup}
        onSelectTimeRange={onSelectTimeRange}
        window={window}
      />
    </div>
  );
}

function PanelContent({
  panel,
  data,
  chartRef,
  crosshairGroup,
  onSelectTimeRange,
  window,
}: {
  panel: Panel;
  data: PanelData;
  chartRef?: React.RefObject<EChartHandle | null>;
  crosshairGroup?: string;
  onSelectTimeRange?: (range: TimeRange) => void;
  window?: ChartContext["window"];
}) {
  const display = useTimeDisplay();
  // The registry decides how the kind is drawn (#61); nothing here names one.
  const renderer = panelRenderer(panel.viz);
  if (renderer.type === "html") {
    return <renderer.Body panel={panel} data={data} />;
  }
  return (
    <EChart
      // A new layout of the same kind (a gauge's dial to bars) is a new chart;
      // a data update never changes this, so it still merges (invariant 11).
      key={`${panel.viz}:${renderer.shape?.(panel) ?? ""}`}
      ref={chartRef}
      option={renderer.option(panel, data, { display, window: window ?? data.window })}
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
                panel.query?.timeField,
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

/**
 * A panel the server has stopped running every tick because it keeps failing
 * (#44): the last error, how long it has been failing, and when it is tried
 * next, so a viewer can tell "paused on purpose" from "still hammering away".
 */
function DegradedBody({ state, onRetry }: { state: PanelState; onRetry?: () => void }) {
  const display = useTimeDisplay();
  const next =
    state.retryAt === undefined
      ? "It will be tried again shortly."
      : `Next attempt at ${formatClockTime(state.retryAt, display)}.`;
  return (
    <ErrorDisplay
      layout="block"
      error={state.error ?? { error: "Query failed", kind: "statement" }}
      note={`Failed ${state.failures ?? 0} times in a row, so it is retried less often. ${next}`}
      onRetry={onRetry}
      retryLabel={state.retrying ? "Retrying…" : "Retry now"}
      disabled={state.retrying}
    />
  );
}

/**
 * A panel on its own window or cadence (#114), saying which. Unlike the status
 * badge it stays visible on a phone: a number read against the wrong window is
 * a wrong number.
 */
function OverrideBadge({ panel }: { panel: Panel }) {
  const display = useTimeDisplay();
  const override = panelOverride(panel, new Date(), display);
  if (!override) return null;
  return (
    <span
      title={override.description}
      className="inline-flex max-w-40 items-center gap-1 truncate bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted"
    >
      <Clock className="h-3 w-3 shrink-0" aria-hidden />
      <span className="truncate" aria-hidden>
        {override.label}
      </span>
      <span className="sr-only">{override.description}</span>
    </span>
  );
}

const STATUS_STYLES: Record<PanelStatus, string> = {
  loading: "bg-surface-2 text-muted",
  live: "bg-success/20 text-success",
  stale: "bg-surface-2 text-muted",
  error: "bg-danger/20 text-danger",
  degraded: "bg-warning/20 text-warning",
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
