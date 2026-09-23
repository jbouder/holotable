import type * as React from "react";
import type { VizType } from "@/lib/ir";
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
 * Purely decorative: every block is `aria-hidden` via {@link Skeleton}, and
 * the caller is what announces that the panel is loading.
 */
export function PanelSkeleton({ viz }: { viz: VizType }) {
  switch (viz) {
    case "stat":
      return <StatSkeleton />;
    case "table":
      return <TableSkeleton />;
    case "pie":
    case "donut":
      return <RadialSkeleton />;
    default:
      return <ChartSkeleton />;
  }
}

/** Bar heights, in percent. Fixed rather than random so nothing re-flows on re-render. */
const BARS = [58, 82, 44, 71, 95, 63, 38, 77, 52, 88, 46, 69];

function ChartSkeleton() {
  return (
    <div className="flex h-full min-h-0 gap-2">
      <div className="flex w-8 shrink-0 flex-col justify-between py-0.5">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-2 w-full" />
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 items-end gap-[3%]">
          {BARS.map((height, i) => (
            <Skeleton
              // Fixed decorative bars: never reordered, never keyed off state.
              // biome-ignore lint/suspicious/noArrayIndexKey: static decorative shapes
              key={i}
              className="min-h-[4px] flex-1"
              style={{ height: `${height}%` }}
            />
          ))}
        </div>
        <Skeleton className="mt-2 h-2 w-full" />
      </div>
    </div>
  );
}

function StatSkeleton() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2">
      <Skeleton className="h-9 w-2/5 min-w-24 sm:h-11" />
      <Skeleton className="h-2.5 w-1/4 min-w-16" />
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-hidden">
      <Row widths={["w-1/3", "w-1/4", "w-1/5"]} className="opacity-80" />
      {[0, 1, 2, 3, 4].map((i) => (
        <Row key={i} widths={["w-2/5", "w-1/3", "w-1/6"]} />
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

function RadialSkeleton() {
  return (
    <div className="flex h-full items-center justify-center">
      <Skeleton className="aspect-square h-full max-h-40 w-auto max-w-full rounded-full" />
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
  viz = "line",
  className,
}: {
  /** The title if the stream has produced one; a placeholder bar if not. */
  title?: string;
  viz?: VizType;
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
        <PanelSkeleton viz={viz} />
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
