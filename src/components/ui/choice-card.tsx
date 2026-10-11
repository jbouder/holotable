"use client";

import * as React from "react";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Two to five pictured options, one chosen: a theme, a color scheme, motion.
 *
 * A Base UI radio group, so the keyboard is a radio group's: Tab reaches the
 * chosen card, the arrow keys move and choose, and a screen reader hears
 * "radio, 2 of 5" with the card's label and description. The picture is the
 * caller's, hidden from assistive technology; the words carry the meaning.
 */
export function ChoiceCardGroup<Value extends string>({
  value,
  onValueChange,
  labelledBy,
  className,
  children,
}: {
  value: Value;
  onValueChange: (value: Value) => void;
  /** The id of the visible heading that names the group (a fieldset's legend). */
  labelledBy: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <RadioGroup
      value={value}
      onValueChange={(next) => onValueChange(next as Value)}
      aria-labelledby={labelledBy}
      className={cn("grid grid-cols-1 gap-3", className)}
    >
      {children}
    </RadioGroup>
  );
}

export function ChoiceCard({
  value,
  label,
  description,
  children,
}: {
  value: string;
  label: React.ReactNode;
  description?: React.ReactNode;
  /** The picture: drawn, not read (it is hidden from assistive technology). */
  children?: React.ReactNode;
}) {
  const id = React.useId();
  return (
    <Radio.Root
      value={value}
      aria-labelledby={`${id}-label`}
      aria-describedby={description ? `${id}-description` : undefined}
      className={cn(
        "flex cursor-pointer flex-col gap-2 rounded-lg border bg-surface p-3 text-left text-sm text-foreground transition-colors duration-(--duration-fast) ease-standard",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "border-border hover:bg-surface-2 data-[checked]:border-primary data-[checked]:inset-ring-1 data-[checked]:inset-ring-primary data-[checked]:hover:bg-surface",
      )}
    >
      {children && (
        <span aria-hidden className="block w-full">
          {children}
        </span>
      )}
      <span className="flex items-center gap-2 font-medium">
        <span id={`${id}-label`} className="flex items-center gap-2">
          {label}
        </span>
        {/* The choice is marked by more than the border's color. */}
        <Radio.Indicator className="ml-auto flex text-primary">
          <Check className="h-4 w-4" aria-hidden />
        </Radio.Indicator>
      </span>
      {description && (
        <span id={`${id}-description`} className="text-xs text-muted">
          {description}
        </span>
      )}
    </Radio.Root>
  );
}
