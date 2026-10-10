import type * as React from "react";
import type { VizType } from "@/lib/ir";
import { findPanelKind, panelKind } from "@/lib/panels/registry";
import type { PanelSkeletonShape } from "@/lib/panels/types";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * The shape of a panel that has not answered yet.
 *
 * Drawn in the panel's own body, at the panel's own grid size, so the page
 * does not move when the rows land — the old centred spinner reserved nothing
 * and every panel popped into place (#72). Shaped by `viz` because a stat and
 * a table settle into very different silhouettes, and a placeholder that lies
 * about which one is coming is its own kind of jump.
 *
 * Every shape follows the same rules, so a dashboard of mixed kinds loads as
 * one surface:
 *
 * - **It fills the body and never overflows it**: the wrapper is the body's
 *   full size and clips, whatever the panel's height.
 * - **Charts share one frame**: y-axis ticks on the left, an x-axis bar along
 *   the bottom, the marks between (bars, a line's area, dots, cells, lanes).
 * - **Lists start at the top and repeat to the bottom**: table rows, log
 *   lines and text lines, at one row height and gap, faded out where the
 *   panel cuts them rather than sliced mid-row.
 * - **Single things are centred**: a stat's number, a dial.
 * - **One tone**: every block is a {@link Skeleton}, shimmer and all, and
 *   each shape uses the same gap scale.
 *
 * Purely decorative: every block is `aria-hidden` via {@link Skeleton}, and
 * the caller is what announces that the panel is loading.
 */
export function PanelSkeleton({ viz }: { viz: VizType }) {
  return <SkeletonShape shape={panelKind(viz).skeleton} />;
}

function SkeletonShape({ shape }: { shape: PanelSkeletonShape }) {
  return (
    <div className="h-full min-h-0 w-full overflow-hidden">
      <Shape shape={shape} />
    </div>
  );
}

function Shape({ shape }: { shape: PanelSkeletonShape }) {
  switch (shape) {
    case "chart":
      return (
        <ChartFrame>
          <Bars />
        </ChartFrame>
      );
    case "line":
      return (
        <ChartFrame>
          <Area />
        </ChartFrame>
      );
    case "scatter":
      return (
        <ChartFrame>
          <Dots />
        </ChartFrame>
      );
    case "cells":
      return (
        <ChartFrame>
          <Cells />
        </ChartFrame>
      );
    case "lanes":
      return (
        <ChartFrame>
          <Lanes />
        </ChartFrame>
      );
    case "blocks":
      return <Blocks />;
    case "grid":
      return <Tiles />;
    case "radial":
      return <Radial />;
    case "ring":
      return <Radial ring />;
    case "stat":
      return <Stat />;
    case "table":
      return <Table />;
    case "lines":
      return <LogLines />;
    case "text":
      return <Text />;
  }
}

// --- Charts: one frame, different marks --------------------------------------

/** Y-axis ticks on the left, an x-axis along the bottom, the marks between. */
function ChartFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-0 gap-2">
      <div className="flex w-8 shrink-0 flex-col justify-between pt-0.5 pb-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-2 w-full" />
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1">{children}</div>
        <Skeleton className="mt-2 h-2 w-full shrink-0" />
      </div>
    </div>
  );
}

/** Bar heights, in percent. Fixed rather than random so nothing re-flows on re-render. */
const BARS = [58, 82, 44, 71, 95, 63, 38, 77, 52, 88, 46, 69];

function Bars() {
  return (
    <div className="flex h-full items-end gap-[3%]">
      {BARS.map((height, i) => (
        <Skeleton
          // biome-ignore lint/suspicious/noArrayIndexKey: static decorative shapes
          key={i}
          className="min-h-[4px] flex-1"
          style={{ height: `${height}%` }}
        />
      ))}
    </div>
  );
}

/** A time series' silhouette: a filled wave, clipped from one block. */
const WAVE =
  "polygon(0% 55%, 9% 40%, 18% 48%, 27% 30%, 36% 38%, 45% 22%, 54% 35%, 63% 28%, 72% 45%, 81% 32%, 90% 40%, 100% 26%, 100% 100%, 0% 100%)";

function Area() {
  return <Skeleton className="absolute inset-0" style={{ clipPath: WAVE }} />;
}

/** Dot positions, `[left, top]` in percent. */
const DOTS: [number, number][] = [
  [6, 70],
  [12, 52],
  [18, 78],
  [24, 40],
  [30, 58],
  [36, 30],
  [42, 64],
  [48, 46],
  [54, 22],
  [60, 50],
  [66, 34],
  [72, 60],
  [78, 18],
  [84, 42],
  [90, 28],
  [95, 54],
];

function Dots() {
  return (
    <>
      {DOTS.map(([left, top], i) => (
        <Skeleton
          // biome-ignore lint/suspicious/noArrayIndexKey: static decorative shapes
          key={i}
          className="absolute size-2.5 rounded-full"
          style={{ left: `${left}%`, top: `${top}%` }}
        />
      ))}
    </>
  );
}

/** Cell strengths for a 4 × 8 heatmap, as opacity. */
const CELLS = [
  0.5, 0.8, 0.4, 1, 0.6, 0.9, 0.5, 0.7, 0.9, 0.4, 0.7, 0.6, 1, 0.5, 0.8, 0.4, 0.6, 1, 0.5,
  0.8, 0.4, 0.7, 0.9, 0.6, 0.4, 0.6, 0.9, 0.5, 0.7, 0.4, 0.6, 1,
];

function Cells() {
  return (
    <div className="grid h-full grid-cols-8 grid-rows-4 gap-0.5">
      {CELLS.map((opacity, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static decorative shapes
        <Skeleton key={i} style={{ opacity }} />
      ))}
    </div>
  );
}

/** Span widths per lane, in percent. Fixed, like the bars, so nothing re-flows. */
const LANES = [
  [38, 22, 40],
  [60, 15, 25],
  [20, 50, 30],
];

function Lanes() {
  return (
    <div className="flex h-full flex-col justify-around">
      {LANES.map((spans, lane) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static decorative shapes
        <div key={lane} className="flex gap-0.5">
          {spans.map((width, i) => (
            <Skeleton
              // biome-ignore lint/suspicious/noArrayIndexKey: static decorative shapes
              key={i}
              className="h-4"
              style={{ width: `${width}%` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

// --- Things that fill the body ------------------------------------------------

/** A treemap's nested rectangles. */
function Blocks() {
  return (
    <div className="grid h-full grid-cols-6 grid-rows-4 gap-0.5">
      <Skeleton className="col-span-3 row-span-4" />
      <Skeleton className="col-span-3 row-span-2" />
      <Skeleton className="col-span-2 row-span-2" />
      <Skeleton className="col-span-1 row-span-1" />
      <Skeleton className="col-span-1 row-span-1" />
    </div>
  );
}

/** A status grid's tiles: as many rows as fit, cut off by the panel. */
function Tiles() {
  return (
    <div
      className={cn("grid content-start gap-1.5", FADE)}
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(7rem, 1fr))" }}
    >
      {Array.from({ length: 24 }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static decorative shapes
        <Skeleton key={i} className="h-14" />
      ))}
    </div>
  );
}

// --- Single things, centred ---------------------------------------------------

/** A pie's disc, or, as a ring, a donut's or a dial's. */
function Radial({ ring = false }: { ring?: boolean }) {
  return (
    <div className="flex h-full items-center justify-center">
      <Skeleton
        className="aspect-square h-full max-h-40 w-auto max-w-full rounded-full"
        style={
          ring
            ? { mask: "radial-gradient(circle, transparent 52%, #000 53%)" }
            : undefined
        }
      />
    </div>
  );
}

function Stat() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2">
      <Skeleton className="h-10 w-1/2 min-w-24 sm:h-12" />
      <Skeleton className="h-2.5 w-1/4 min-w-16" />
    </div>
  );
}

// --- Lists: from the top, repeated to the bottom ------------------------------

/** Enough rows to fill any panel; the wrapper cuts off what does not fit. */
const LIST_ROWS = 16;

/** Fades a list out over its last stretch, so a cut row is not a sliver. */
const FADE = "h-full [mask-image:linear-gradient(to_bottom,#000_80%,transparent)]";

function Table() {
  return (
    <div className={cn("flex flex-col gap-2", FADE)}>
      <Row widths={["w-1/3", "w-1/4", "w-1/5"]} className="opacity-80" />
      {Array.from({ length: LIST_ROWS }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static decorative shapes
        <Row key={i} widths={["w-2/5", "w-1/3", "w-1/6"]} />
      ))}
    </div>
  );
}

/** Message widths for log lines, so they read as text of varying length. */
const MESSAGES = ["w-3/5", "w-2/5", "w-1/2", "w-3/4", "w-1/3", "w-2/3"];

function LogLines() {
  return (
    <div className={cn("flex flex-col gap-2", FADE)}>
      {Array.from({ length: LIST_ROWS }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static decorative shapes
        <div key={i} className="flex shrink-0 items-center gap-3">
          <Skeleton className="h-2.5 w-16 shrink-0" />
          <Skeleton className="h-2.5 w-8 shrink-0" />
          <Skeleton className={cn("h-2.5", MESSAGES[i % MESSAGES.length])} />
        </div>
      ))}
    </div>
  );
}

const PROSE = ["w-4/5", "w-3/5", "w-11/12", "w-2/3", "w-3/4", "w-1/2"];

function Text() {
  return (
    <div className={cn("flex flex-col gap-2", FADE)}>
      <Skeleton className="mb-1 h-4 w-1/3 shrink-0" />
      {Array.from({ length: LIST_ROWS }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static decorative shapes
        <Skeleton key={i} className={cn("h-2.5 shrink-0", PROSE[i % PROSE.length])} />
      ))}
    </div>
  );
}

function Row({ widths, className }: { widths: string[]; className?: string }) {
  return (
    <div className={cn("flex shrink-0 items-center gap-3", className)}>
      {widths.map((w) => (
        <Skeleton key={w} className={cn("h-2.5", w)} />
      ))}
    </div>
  );
}

/**
 * A whole panel-shaped card: the chrome as well as the body.
 *
 * Used where the panel itself does not exist yet — the streaming generator on
 * `/dashboards/new`, where titles arrive one at a time and a card has to stand
 * in for the one still being written.
 */
export function PanelCardSkeleton({
  title,
  viz,
  className,
}: {
  /** The title if the stream has produced one; a placeholder bar if not. */
  title?: string;
  /**
   * The kind, as far as the stream has written it. A string still arriving
   * (`"do"` on its way to `"donut"`) is not a kind yet, and draws as a chart.
   */
  viz?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-48 flex-col border border-border bg-surface shadow-sm",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        {title ? (
          <h4 className="min-w-0 truncate text-sm font-semibold">{title}</h4>
        ) : (
          <Skeleton className="h-3.5 w-32" />
        )}
        <Skeleton className="h-4 w-12" />
      </div>
      <div className="min-h-0 flex-1 px-4 pb-3">
        <SkeletonShape shape={findPanelKind(viz)?.skeleton ?? "chart"} />
      </div>
    </div>
  );
}

/** Screen-reader-only announcement to pair with a skeleton. */
export function LoadingLabel({ children }: { children: React.ReactNode }) {
  return (
    <span role="status" className="sr-only">
      {children}
    </span>
  );
}
