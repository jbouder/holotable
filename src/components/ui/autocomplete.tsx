"use client";

import type * as React from "react";
import { Autocomplete as BaseAutocomplete } from "@base-ui/react/autocomplete";
import { cn } from "@/lib/utils";

export interface Suggestion {
  value: string;
  /** Shown beside the value when it differs, and matched like it. */
  label?: string;
}

/** The most suggestions drawn at once; typing narrows the rest. */
const LIMIT = 100;

const matches = (item: Suggestion, query: string) => {
  const q = query.trim().toLowerCase();
  return (
    q === "" ||
    item.value.toLowerCase().includes(q) ||
    (item.label?.toLowerCase().includes(q) ?? false)
  );
};

/**
 * A text input that suggests values without restricting them: whatever is
 * typed is the value, and a suggestion only fills it in. Base UI's
 * Autocomplete, drawn like `Select`'s popup, rather than a native
 * `<datalist>`, whose list the browser draws in its own style.
 */
export function Autocomplete({
  value,
  onValueChange,
  suggestions,
  className,
  ...inputProps
}: {
  value: string;
  onValueChange: (value: string) => void;
  suggestions: readonly Suggestion[];
  className?: string;
} & Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "value" | "defaultValue" | "onChange" | "list" | "className"
>) {
  return (
    <BaseAutocomplete.Root
      items={suggestions}
      value={value}
      onValueChange={(next) => onValueChange(next)}
      itemToStringValue={(item: Suggestion) => item.value}
      filter={matches}
      limit={LIMIT}
      openOnInputClick
    >
      <BaseAutocomplete.Input
        {...inputProps}
        className={cn(
          "h-10 w-full rounded-lg border border-border-strong bg-surface px-3 text-sm text-foreground placeholder:text-muted focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
      />
      <BaseAutocomplete.Portal>
        <BaseAutocomplete.Positioner sideOffset={4} className="z-50">
          <BaseAutocomplete.Popup className="w-(--anchor-width) max-w-(--available-width) origin-(--transform-origin) rounded-lg border border-border bg-surface-2 shadow-lg transition-[opacity,scale] duration-(--duration-fast) ease-standard data-starting-style:opacity-0 data-starting-style:scale-[0.98] data-ending-style:opacity-0 data-ending-style:scale-[0.98]">
            <BaseAutocomplete.Empty>
              <p className="px-3 py-2 text-sm text-muted">
                No match listed. The text as typed is used.
              </p>
            </BaseAutocomplete.Empty>
            <BaseAutocomplete.List className="max-h-[min(16rem,var(--available-height))] overflow-y-auto overscroll-contain p-1 data-empty:p-0">
              {(item: Suggestion) => (
                <BaseAutocomplete.Item
                  key={item.value}
                  value={item}
                  className="block cursor-pointer px-2 py-1.5 text-sm text-foreground data-[highlighted]:bg-surface"
                >
                  <span className="block break-all font-mono text-xs">{item.value}</span>
                  {item.label && item.label !== item.value && (
                    <span className="block truncate text-xs text-muted">
                      {item.label}
                    </span>
                  )}
                </BaseAutocomplete.Item>
              )}
            </BaseAutocomplete.List>
          </BaseAutocomplete.Popup>
        </BaseAutocomplete.Positioner>
      </BaseAutocomplete.Portal>
    </BaseAutocomplete.Root>
  );
}
