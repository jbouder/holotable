"use client";

import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Move,
  RotateCcw,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import * as React from "react";
import type { RoamStep } from "@/components/charts/EChart";
import { cn } from "@/lib/utils";

/** What each control does, its name, the key that does the same, and its icon. */
const CONTROLS: {
  step: RoamStep;
  label: string;
  keys: string[];
  shortcut: string;
  Icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
}[][] = [
  [
    { step: "in", label: "Zoom in", keys: ["+", "="], shortcut: "+", Icon: ZoomIn },
    { step: "out", label: "Zoom out", keys: ["-", "_"], shortcut: "-", Icon: ZoomOut },
    { step: "reset", label: "Reset view", keys: ["0"], shortcut: "0", Icon: RotateCcw },
  ],
  [
    {
      step: "left",
      label: "Pan left",
      keys: ["ArrowLeft"],
      shortcut: "ArrowLeft",
      Icon: ArrowLeft,
    },
    {
      step: "up",
      label: "Pan up",
      keys: ["ArrowUp"],
      shortcut: "ArrowUp",
      Icon: ArrowUp,
    },
    {
      step: "down",
      label: "Pan down",
      keys: ["ArrowDown"],
      shortcut: "ArrowDown",
      Icon: ArrowDown,
    },
    {
      step: "right",
      label: "Pan right",
      keys: ["ArrowRight"],
      shortcut: "ArrowRight",
      Icon: ArrowRight,
    },
  ],
];

const BUTTON =
  "tap-target inline-flex h-7 w-7 cursor-pointer items-center justify-center text-muted transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring";

const STEP_OF_KEY = new Map(
  CONTROLS.flat().flatMap((c) => c.keys.map((k) => [k, c.step] as const)),
);

/**
 * Zoom and pan for a chart that roams (#682): what a drag, a pinch or Ctrl
 * and the wheel do, as buttons for whoever cannot drag (WCAG 2.5.7) and as
 * keys for a keyboard (2.1.1). While focus is on any of them, `+` and `-`
 * zoom, `0` puts the view back and the arrow keys pan.
 *
 * Drawn over the chart's corner, small, like the datum links control; a
 * coarse pointer gets the full touch target (`tap-target`). Below `sm` those
 * targets would cover a third of a phone's chart, so the set folds behind
 * one toggle there, which a drag and a pinch rarely need; Escape folds it.
 */
export function RoamControls({
  label,
  onStep,
}: {
  /** The chart's name, so the group says whose view it moves. */
  label: string;
  onStep: (step: RoamStep) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  return (
    // A fieldset is a group; the keys are shortcuts for the buttons inside,
    // each of which works on its own. `min-w-0` undoes a fieldset's own.
    <fieldset
      aria-label={`Zoom and pan ${label}`}
      onKeyDown={(e) => {
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        if (e.key === "Escape" && open) {
          setOpen(false);
          return;
        }
        const step = STEP_OF_KEY.get(e.key);
        if (!step) return;
        // The arrow keys would scroll the page as well.
        e.preventDefault();
        onStep(step);
      }}
      className="absolute bottom-1 left-1 z-10 m-0 flex min-w-0 flex-col items-start gap-0.5 border border-border bg-surface p-0"
    >
      <button
        type="button"
        aria-label={open ? "Hide zoom and pan" : "Zoom and pan"}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className={cn(BUTTON, "sm:hidden")}
      >
        {open ? (
          <X className="h-4 w-4" aria-hidden />
        ) : (
          <Move className="h-4 w-4" aria-hidden />
        )}
      </button>
      <div id={id} className={cn("flex flex-col gap-0.5", !open && "max-sm:hidden")}>
        {CONTROLS.map((row) => (
          <div key={row[0].step} className="flex">
            {row.map(({ step, label: name, shortcut, Icon }) => (
              <button
                key={step}
                type="button"
                aria-label={name}
                aria-keyshortcuts={shortcut}
                title={name}
                onClick={() => onStep(step)}
                className={BUTTON}
              >
                <Icon className="h-4 w-4" aria-hidden />
              </button>
            ))}
          </div>
        ))}
      </div>
    </fieldset>
  );
}
