"use client";

import * as React from "react";
import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A ticked box with its label. The label is part of the control rather than a
 * caller's concern because the hit target should be the whole row, not the
 * 16 pixels of the box.
 */
export function Checkbox({
  checked,
  onCheckedChange,
  label,
  id,
  disabled,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: React.ReactNode;
  id?: string;
  disabled?: boolean;
  className?: string;
}) {
  const generatedId = React.useId();
  const inputId = id ?? generatedId;
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <BaseCheckbox.Root
        id={inputId}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onCheckedChange(next)}
        className="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded border border-border bg-surface text-background focus-visible:outline-2 focus-visible:outline-primary data-[checked]:border-primary data-[checked]:bg-primary data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50"
      >
        <BaseCheckbox.Indicator className="flex">
          <Check className="h-3 w-3" strokeWidth={3} />
        </BaseCheckbox.Indicator>
      </BaseCheckbox.Root>
      <label
        htmlFor={inputId}
        className={cn(
          "cursor-pointer text-sm text-foreground",
          disabled && "cursor-not-allowed opacity-50",
        )}
      >
        {label}
      </label>
    </div>
  );
}
