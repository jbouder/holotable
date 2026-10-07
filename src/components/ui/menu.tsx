"use client";

import type * as React from "react";
import Link from "next/link";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { Check } from "lucide-react";
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
              // Fade with a 4px nudge from the anchor side (#235): the popup
              // starts and ends slightly towards its trigger. Base UI puts the
              // resolved side on the popup, so a flip to `top` nudges the other way.
              "transition-[opacity,translate] duration-(--duration-fast) ease-standard data-starting-style:opacity-0 data-ending-style:opacity-0 data-[side=bottom]:data-starting-style:-translate-y-1 data-[side=bottom]:data-ending-style:-translate-y-1 data-[side=top]:data-starting-style:translate-y-1 data-[side=top]:data-ending-style:translate-y-1",
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

/**
 * One action. `danger` marks the destructive one, which is always last.
 *
 * With `href` the item renders as a link, so a download stays a plain
 * `<a download>` the browser handles, not a click handler that fakes one.
 */
export function MenuItem({
  children,
  disabled,
  danger,
  onClick,
  href,
  download,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  danger?: boolean;
  onClick?: () => void;
  href?: string;
  download?: boolean;
}) {
  return (
    <BaseMenu.Item
      disabled={disabled}
      onClick={onClick}
      render={
        href
          ? (props) => (
              <a {...props} href={href} download={download}>
                {props.children}
              </a>
            )
          : undefined
      }
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

const ITEM_CLASS =
  "tap-target flex cursor-pointer select-none items-center gap-2 px-2 py-1.5 text-sm text-foreground outline-none data-[highlighted]:bg-surface-2 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40";

/**
 * An in-app page. A real Next `<Link>`, so the destination is prefetched and
 * middle-click still opens a tab, which a click handler calling the router
 * would lose. The menu closes on the click, since the page is changing.
 */
export function MenuLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <BaseMenu.LinkItem closeOnClick render={<Link href={href} />} className={ITEM_CLASS}>
      {children}
    </BaseMenu.LinkItem>
  );
}

/**
 * A set of mutually exclusive choices, e.g. the theme. The items are
 * `menuitemradio`s with `aria-checked`, and the group carries the name a
 * screen reader announces, because a visual caption above it is not
 * associated with the group by the ARIA menu pattern.
 */
export function MenuRadioGroup<T extends string>({
  label,
  value,
  onValueChange,
  children,
}: {
  label: string;
  value: T;
  onValueChange: (value: T) => void;
  children: React.ReactNode;
}) {
  return (
    <BaseMenu.RadioGroup
      aria-label={label}
      value={value}
      onValueChange={(next) => onValueChange(next as T)}
    >
      <div
        aria-hidden
        className="px-2 pt-1.5 pb-1 text-xs font-semibold uppercase tracking-wide text-muted"
      >
        {label}
      </div>
      {children}
    </BaseMenu.RadioGroup>
  );
}

/** One choice in a {@link MenuRadioGroup}. Stays open, so the effect is visible. */
export function MenuRadioItem({
  value,
  children,
}: {
  value: string;
  children: React.ReactNode;
}) {
  return (
    <BaseMenu.RadioItem value={value} closeOnClick={false} className={ITEM_CLASS}>
      {children}
      <BaseMenu.RadioItemIndicator className="ml-auto text-primary">
        <Check className="h-4 w-4" aria-hidden />
      </BaseMenu.RadioItemIndicator>
    </BaseMenu.RadioItem>
  );
}

/**
 * A captioned group of items. Unlike {@link MenuRadioGroup}'s caption, this
 * one is Base UI's `GroupLabel`, so the group is named by what is on screen.
 */
export function MenuGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <BaseMenu.Group>
      <BaseMenu.GroupLabel className="px-2 pt-1.5 pb-1 text-xs font-semibold uppercase tracking-wide text-muted">
        {label}
      </BaseMenu.GroupLabel>
      {children}
    </BaseMenu.Group>
  );
}

/** An item that toggles. Stays open, so several can be ticked in one visit. */
export function MenuCheckboxItem({
  checked,
  onCheckedChange,
  disabled,
  children,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <BaseMenu.CheckboxItem
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      closeOnClick={false}
      className={ITEM_CLASS}
    >
      {children}
      <BaseMenu.CheckboxItemIndicator className="ml-auto text-primary">
        <Check className="h-4 w-4" aria-hidden />
      </BaseMenu.CheckboxItemIndicator>
    </BaseMenu.CheckboxItem>
  );
}
