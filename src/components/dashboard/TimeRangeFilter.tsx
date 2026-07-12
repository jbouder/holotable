"use client";

import type { TimeRange } from "@/lib/ir";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const PRESETS = [
  { label: "15m", from: "now-15m" },
  { label: "1h", from: "now-1h" },
  { label: "6h", from: "now-6h" },
  { label: "24h", from: "now-24h" },
  { label: "7d", from: "now-7d" },
] as const;

export function TimeRangeFilter({
  value,
  onChange,
}: {
  value: TimeRange;
  onChange: (range: TimeRange) => void;
}) {
  return (
    <div
      className="flex items-center rounded-lg border border-border bg-surface p-1"
      role="group"
      aria-label="Dashboard time range"
    >
      {PRESETS.map((preset) => {
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
  );
}
