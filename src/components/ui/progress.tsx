"use client";

import type * as React from "react";
import { Progress as BaseProgress } from "@base-ui/react/progress";
import { cn } from "@/lib/utils";

/**
 * How far along something is (#595), on Base UI's Progress: the
 * `progressbar` role, its label and its value come from there. `value` is
 * null for the stretch where the work is under way but cannot be measured
 * (the server checking what it was sent), which slides a segment instead.
 *
 * The bar moves by `transform` only (a `scaleX` from the start edge), with
 * the duration and easing tokens, so the global reduce-motion rule stills it
 * like every other transition. Base UI's own indicator sizes itself by
 * `width`, so the bar is drawn here instead.
 */
export function Progress({
  value,
  max = 100,
  label,
  valueText,
  tone = "default",
  className,
}: {
  /** Between 0 and `max`, or null while it cannot be measured. */
  value: number | null;
  max?: number;
  /** What is progressing; also the bar's accessible name. */
  label: React.ReactNode;
  /** The value in words, shown beside the label and read as `aria-valuetext`. */
  valueText?: string;
  /** `danger` for work that failed, `success` once it is done. */
  tone?: "default" | "danger" | "success";
  className?: string;
}) {
  const fraction = value === null ? 0 : Math.min(1, Math.max(0, value / max));
  return (
    <BaseProgress.Root
      value={value}
      max={max}
      getAriaValueText={valueText ? () => valueText : undefined}
      className={cn("min-w-0 space-y-1", className)}
    >
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <BaseProgress.Label className="min-w-0 truncate font-medium text-foreground">
          {label}
        </BaseProgress.Label>
        {valueText && (
          <span className="shrink-0 tabular-nums text-muted">{valueText}</span>
        )}
      </div>
      <BaseProgress.Track className="relative h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div
          aria-hidden
          className={cn(
            "absolute inset-y-0 left-0 rounded-full",
            tone === "danger"
              ? "bg-danger"
              : tone === "success"
                ? "bg-success"
                : "bg-primary",
            value === null
              ? "progress-indeterminate w-1/3"
              : "w-full origin-left transition-transform duration-(--duration-base) ease-standard",
          )}
          style={value === null ? undefined : { transform: `scaleX(${fraction})` }}
        />
      </BaseProgress.Track>
    </BaseProgress.Root>
  );
}
