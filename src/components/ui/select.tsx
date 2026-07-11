"use client";

import * as React from "react";
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
}: {
  value: string | null;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
  id?: string;
}) {
  return (
    <BaseSelect.Root
      value={value}
      onValueChange={(v) => onValueChange(String(v))}
      items={options.map((o) => ({ value: o.value, label: o.label }))}
    >
      <BaseSelect.Trigger
        id={id}
        className={cn(
          "flex h-10 min-w-40 items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-primary",
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
          <BaseSelect.Popup className="max-h-64 overflow-auto rounded-lg border border-border bg-surface-2 p-1 shadow-lg">
            {options.map((o) => (
              <BaseSelect.Item
                key={o.value}
                value={o.value}
                className="flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5 text-sm text-foreground data-[highlighted]:bg-surface"
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
