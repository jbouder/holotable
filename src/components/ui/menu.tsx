"use client";

import type * as React from "react";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { cn } from "@/lib/utils";

/**
 * An overflow menu: one labelled trigger, a list of actions behind it.
 *
 * The alternative it replaces is a row of bare icons, which is how the panel
 * list lost its accessible names — an action needs a name a screen reader can
 * read and a keyboard can reach, and a menu gives every action both for the
 * price of one trigger.
 */
export function Menu({
  label,
  trigger,
  children,
  className,
  panelClassName,
}: {
  /** The trigger's accessible name — it holds an icon, so it needs one. */
  label: string;
  trigger: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** Widens the popup for a menu whose items are sentences, not verbs. */
  panelClassName?: string;
}) {
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger
        aria-label={label}
        title={label}
        className={cn(
          "tap-target inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center text-muted transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary data-[popup-open]:bg-surface-3 data-[popup-open]:text-foreground",
          className,
        )}
      >
        {trigger}
      </BaseMenu.Trigger>
      <BaseMenu.Portal>
        <BaseMenu.Positioner side="bottom" align="end" sideOffset={4} className="z-50">
          <BaseMenu.Popup
            className={cn(
              "min-w-44 border border-border bg-surface p-1 shadow-xl focus:outline-none",
              panelClassName,
            )}
          >
            {children}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}

/** One action. `danger` marks the destructive one, which is always last. */
export function MenuItem({
  children,
  disabled,
  danger,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <BaseMenu.Item
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "tap-target flex cursor-pointer select-none items-center gap-2 px-2 py-1.5 text-sm text-foreground outline-none data-[highlighted]:bg-surface-2 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40",
        danger && "text-danger data-[highlighted]:bg-danger/10",
      )}
    >
      {children}
    </BaseMenu.Item>
  );
}

/** A hairline between groups of actions. */
export function MenuSeparator() {
  return <hr className="my-1 h-px border-0 bg-border" />;
}
