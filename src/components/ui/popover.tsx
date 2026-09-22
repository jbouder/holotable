"use client";

import type * as React from "react";
import { Popover as BasePopover } from "@base-ui/react/popover";
import { cn } from "@/lib/utils";

/**
 * A small panel of text anchored to the control that opens it.
 *
 * Deliberately a popover and not a tooltip: the content is prose a reader may
 * want to keep open and select, and a tooltip is not reachable by touch.
 */
export function Popover({
  label,
  trigger,
  children,
  className,
}: {
  /** The trigger's accessible name — it holds an icon, so it needs one. */
  label: string;
  trigger: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <BasePopover.Root>
      <BasePopover.Trigger
        aria-label={label}
        title={label}
        className={cn(
          "inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded text-muted transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary data-[popup-open]:bg-surface-2 data-[popup-open]:text-foreground",
          className,
        )}
      >
        {trigger}
      </BasePopover.Trigger>
      <BasePopover.Portal>
        <BasePopover.Positioner side="bottom" align="end" sideOffset={4} className="z-50">
          <BasePopover.Popup className="max-w-xs rounded-lg border border-border bg-surface p-3 text-xs leading-relaxed text-foreground shadow-xl focus:outline-none">
            {children}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
}
