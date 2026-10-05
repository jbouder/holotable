"use client";

import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SelectOption {
  value: string;
  label: string;
}

export function Select({
  value,
  onValueChange,
  options,
  placeholder = "Select…",
  className,
  id,
  disabled,
  "aria-label": ariaLabel,
}: {
  value: string | null;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
  id?: string;
  disabled?: boolean;
  /**
   * The name, when no `<Label htmlFor={id}>` gives it one. A combobox with
   * neither is announced as an unnamed button (#77).
   */
  "aria-label"?: string;
}) {
  return (
    <BaseSelect.Root
      value={value}
      disabled={disabled}
      onValueChange={(v) => onValueChange(String(v))}
      items={options.map((o) => ({ value: o.value, label: o.label }))}
    >
      <BaseSelect.Trigger
        id={id}
        aria-label={ariaLabel}
        className={cn(
          "flex h-10 min-w-40 items-center justify-between gap-2 border border-border bg-surface px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-primary data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
          className,
        )}
      >
        <BaseSelect.Value>
          {(val: string | null) =>
            options.find((o) => o.value === val)?.label ?? placeholder
          }
        </BaseSelect.Value>
        <BaseSelect.Icon>
          <ChevronDown className="h-4 w-4 opacity-70" />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={4} className="z-50">
          {/*
            Fade and settle from 98% about the anchor (#235). A select's popup
            lines its chosen item up with the trigger rather than sitting on
            one side of it, so there is no side to nudge from.
          */}
          <BaseSelect.Popup className="max-h-64 origin-(--transform-origin) overflow-auto border border-border bg-surface-2 p-1 shadow-lg transition-[opacity,scale] duration-(--duration-fast) ease-standard data-starting-style:opacity-0 data-starting-style:scale-[0.98] data-ending-style:opacity-0 data-ending-style:scale-[0.98]">
            {options.map((o) => (
              <BaseSelect.Item
                key={o.value}
                value={o.value}
                className="flex cursor-pointer items-center justify-between gap-2 px-2 py-1.5 text-sm text-foreground data-[highlighted]:bg-surface"
              >
                <BaseSelect.ItemText>{o.label}</BaseSelect.ItemText>
                <BaseSelect.ItemIndicator>
                  <Check className="h-4 w-4" />
                </BaseSelect.ItemIndicator>
              </BaseSelect.Item>
            ))}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
