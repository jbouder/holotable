"use client";

import * as React from "react";
import { Popover as BasePopover } from "@base-ui/react/popover";
import { cn } from "@/lib/utils";

/**
 * A small panel anchored to the control that opens it.
 *
 * Deliberately a popover and not a tooltip: the content is prose a reader may
 * want to keep open and select, or a form they need to reach, and a tooltip is
 * neither selectable nor reachable by touch.
 *
 * `children` may be a function, which receives a `close` callback — a form
 * inside a popover needs to dismiss itself once it has been applied. That is
 * why the open state is held here rather than left to Base UI: `Popover.Close`
 * closes on a click of the element it renders, and "apply, then close" is not
 * a click on anything in particular.
 */
export function Popover({
  label,
  trigger,
  children,
  className,
  panelClassName,
  align = "end",
}: {
  /** The trigger's accessible name — it usually holds an icon, so it needs one. */
  label: string;
  trigger: React.ReactNode;
  children: React.ReactNode | ((close: () => void) => React.ReactNode);
  /** Replaces the default icon-button trigger styling when a caller needs a wider control. */
  className?: string;
  panelClassName?: string;
  align?: "start" | "center" | "end";
}) {
  const [open, setOpen] = React.useState(false);
  const close = React.useCallback(() => setOpen(false), []);

  return (
    <BasePopover.Root open={open} onOpenChange={setOpen}>
      <BasePopover.Trigger
        aria-label={label}
        title={label}
        className={cn(
          "inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center text-muted transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary data-[popup-open]:bg-surface-2 data-[popup-open]:text-foreground",
          className,
        )}
      >
        {trigger}
      </BasePopover.Trigger>
      <BasePopover.Portal>
        <BasePopover.Positioner
          side="bottom"
          align={align}
          sideOffset={4}
          className="z-50"
        >
          <BasePopover.Popup
            className={cn(
              "max-w-xs border border-border bg-surface p-3 text-xs leading-relaxed text-foreground shadow-xl focus:outline-none",
              panelClassName,
            )}
          >
            {typeof children === "function" ? children(close) : children}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
}
