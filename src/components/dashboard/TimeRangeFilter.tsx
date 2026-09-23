"use client";

import * as React from "react";
import { Clock, ChevronLeft, ChevronRight, ZoomOut } from "lucide-react";
import type { TimeRange } from "@/lib/ir";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Popover } from "@/components/ui/popover";
import {
  absoluteRange,
  describeRange,
  fromLocalInput,
  isRolling,
  parseRelative,
  RANGE_PRESETS,
  relativeExpr,
  relativeRange,
  type RelativeUnit,
  shiftRange,
  spanMs,
  toLocalInput,
  UNIT_LABELS,
  zoomRange,
} from "@/lib/time-range";
import { resolveTimeRange } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useTimeDisplay, useZoneBadge } from "@/components/time-display";
import type { TimeDisplay } from "@/lib/time-display";

/**
 * Seconds are deliberately absent: a window narrower than a minute is shorter
 * than the refresh interval of every dashboard the app will accept, so offering
 * it would only produce empty charts. `relativeExpr` can still emit one, which
 * is what a brush on a very short window needs.
 */
const UNIT_CHOICES: RelativeUnit[] = ["m", "h", "d", "w"];

/** The width "Back to live" falls back to when the frozen window does not resolve. */
const HOUR = 3_600_000;

/**
 * The dashboard time picker.
 *
 * Three ways to say the same thing — a preset, a custom relative width, or two
 * absolute instants — plus shift and zoom over whatever is currently selected.
 * Everything it emits is an IR `TimeExpr` pair that the server resolves for
 * itself on every tick; this control is never the authority on what window was
 * actually queried (invariant 4).
 */
export function TimeRangeFilter({
  value,
  onChange,
}: {
  value: TimeRange;
  onChange: (range: TimeRange) => void;
}) {
  const rolling = isRolling(value);
  const display = useTimeDisplay();
  const zone = useZoneBadge();

  return (
    <div className="flex items-center gap-1">
      <div className="flex items-center border border-border bg-surface p-1">
        <IconButton
          label="Shift back one window"
          onClick={() => onChange(shiftRange(value, -1))}
        >
          <ChevronLeft className="h-4 w-4" />
        </IconButton>
        <Popover
          label="Change the time range"
          align="end"
          panelClassName="w-80 max-w-[min(20rem,calc(100vw-2rem))] p-4"
          className={cn("h-7 w-auto gap-1.5 px-2 text-xs", !rolling && "text-warning")}
          trigger={
            <>
              <Clock className="h-3.5 w-3.5" aria-hidden />
              <span className="max-w-44 truncate">
                {describeRange(value, new Date(), display)}
              </span>
              {zone && (
                <span className="border border-border px-1 text-[10px] text-muted">
                  {zone}
                </span>
              )}
            </>
          }
        >
          {(close) => (
            <RangeForm
              value={value}
              display={display}
              zone={zone}
              onChange={(next) => {
                onChange(next);
                close();
              }}
            />
          )}
        </Popover>
        <IconButton
          label="Shift forward one window"
          onClick={() => onChange(shiftRange(value, 1))}
        >
          <ChevronRight className="h-4 w-4" />
        </IconButton>
        <IconButton label="Zoom out" onClick={() => onChange(zoomRange(value, 2))}>
          <ZoomOut className="h-4 w-4" />
        </IconButton>
      </div>
      {!rolling && <FixedRangeBadge value={value} onChange={onChange} />}
    </div>
  );
}

/**
 * An absolute window is frozen: the poller keeps ticking but the same seconds
 * are being re-queried, so the charts stop moving. Saying so — and offering the
 * way back — is the difference between "fixed range" and "the dashboard broke".
 */
function FixedRangeBadge({
  value,
  onChange,
}: {
  value: TimeRange;
  onChange: (range: TimeRange) => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 bg-warning/15 py-0.5 pl-2 pr-1 text-xs font-medium text-warning">
      Fixed range
      <Button
        variant="ghost"
        size="sm"
        aria-label="Back to live"
        className="h-5 px-1.5 text-[11px] text-warning hover:bg-warning/20 hover:text-warning"
        // Back to live keeps the width the reader chose and only unpins the
        // end of it: they were looking at an hour of history, so they get the
        // last hour, not whichever preset happens to be second in the list.
        onClick={() => onChange({ from: relativeExpr(spanMs(value) ?? HOUR), to: "now" })}
      >
        Back to live
      </Button>
    </span>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={label}
      title={label}
      className="h-7 w-7 px-0 text-muted hover:text-foreground"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

/**
 * The popover body. Local state is per-form, not per-dashboard: nothing here
 * changes the window until Apply, so an abandoned half-typed absolute range
 * leaves the dashboard exactly where it was.
 */
function RangeForm({
  value,
  display,
  zone,
  onChange,
}: {
  value: TimeRange;
  display: TimeDisplay;
  zone: string | null;
  onChange: (range: TimeRange) => void;
}) {
  const initialRelative = parseRelative(value.from);
  const [amount, setAmount] = React.useState(() =>
    initialRelative && initialRelative.amount > 0 ? String(initialRelative.amount) : "30",
  );
  const [unit, setUnit] = React.useState<RelativeUnit>(
    () => initialRelative?.unit ?? "m",
  );
  const [from, setFrom] = React.useState(() => localInputFor(value, "from", display));
  const [to, setTo] = React.useState(() => localInputFor(value, "to", display));

  const relative = relativeRange(Number(amount), unit);
  const fromDate = fromLocalInput(from, display);
  const toDate = fromLocalInput(to, display);
  const absolute = fromDate && toDate ? absoluteRange(fromDate, toDate) : null;
  const absoluteError =
    from && to && !absolute ? "Pick an end at least a second after the start." : null;

  return (
    <div className="space-y-4 text-xs">
      <fieldset>
        <legend className="mb-2 block text-sm font-medium text-muted">
          Quick ranges
        </legend>
        <div className="flex flex-wrap gap-1">
          {RANGE_PRESETS.map((preset) => {
            const selected = value.from === preset.from && value.to === "now";
            return (
              <Button
                key={preset.from}
                variant="ghost"
                size="sm"
                aria-pressed={selected}
                className={cn(
                  "h-7 px-2 text-xs text-muted hover:text-foreground",
                  selected && "bg-surface-2 text-foreground",
                )}
                onClick={() => onChange({ from: preset.from, to: "now" })}
              >
                {preset.label}
              </Button>
            );
          })}
        </div>
      </fieldset>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (relative) onChange(relative);
        }}
      >
        <Label htmlFor="range-relative-amount" className="text-sm">
          Last…
        </Label>
        <div className="flex items-center gap-2">
          <Input
            id="range-relative-amount"
            type="number"
            min={1}
            step={1}
            value={amount}
            className="h-8 w-16"
            onChange={(e) => setAmount(e.target.value)}
          />
          <fieldset
            className="flex items-center gap-0.5 border border-border p-0.5"
            aria-label="Unit"
          >
            {UNIT_CHOICES.map((choice) => (
              <Button
                key={choice}
                type="button"
                variant="ghost"
                size="sm"
                aria-pressed={unit === choice}
                aria-label={UNIT_LABELS[choice]}
                className={cn(
                  "h-6 px-2 text-xs text-muted hover:text-foreground",
                  unit === choice && "bg-surface-2 text-foreground",
                )}
                onClick={() => setUnit(choice)}
              >
                {choice}
              </Button>
            ))}
          </fieldset>
          <Button type="submit" size="sm" className="h-8 flex-1" disabled={!relative}>
            Apply
          </Button>
        </div>
      </form>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (absolute) onChange(absolute);
        }}
      >
        <Label htmlFor="range-absolute-from" className="text-sm">
          Absolute range
        </Label>
        <div className="space-y-2">
          <Input
            id="range-absolute-from"
            type="datetime-local"
            aria-label="Range start"
            value={from}
            className="h-8"
            onChange={(e) => setFrom(e.target.value)}
          />
          <Input
            id="range-absolute-to"
            type="datetime-local"
            aria-label="Range end"
            value={to}
            className="h-8"
            onChange={(e) => setTo(e.target.value)}
          />
          {absoluteError && <p className="text-danger">{absoluteError}</p>}
          <Button type="submit" size="sm" className="h-8 w-full" disabled={!absolute}>
            Apply absolute range
          </Button>
        </div>
      </form>

      <p className="text-muted">
        Times are shown in {zone ?? "your local zone"} and stored as UTC. The server
        resolves the window it actually queries.
      </p>
    </div>
  );
}

/**
 * Seed the absolute inputs from wherever the picker currently is, so opening it
 * on a live dashboard offers that window rather than an empty pair of fields.
 */
function localInputFor(
  value: TimeRange,
  end: "from" | "to",
  display: TimeDisplay,
): string {
  try {
    return toLocalInput(resolveTimeRange(value)[end], display);
  } catch {
    return "";
  }
}
