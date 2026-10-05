"use client";

import { ChevronDown } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover } from "@/components/ui/popover";
import { Select } from "@/components/ui/select";
import type { Selection, VariableChoice } from "@/lib/variable-selection";

/**
 * The viewer's pickers for a dashboard's variables (#67). They offer only the
 * values the server listed for this viewer, and the server checks every pick
 * again when the stream opens, so this is a convenience and never the check.
 */
export function VariablePickers({
  choices,
  selection,
  onChange,
}: {
  choices: readonly VariableChoice[];
  selection: Selection;
  onChange: (selection: Selection) => void;
}) {
  if (choices.length === 0) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {choices.map((choice) => (
        <VariablePicker
          key={choice.name}
          choice={choice}
          value={selection[choice.name] ?? []}
          onChange={(values) => onChange({ ...selection, [choice.name]: values })}
        />
      ))}
    </div>
  );
}

function VariablePicker({
  choice,
  value,
  onChange,
}: {
  choice: VariableChoice;
  value: string[];
  onChange: (values: string[]) => void;
}) {
  const id = `var-${choice.name}`;
  if (choice.error) {
    return (
      <span
        className="border border-danger/40 px-2 py-1 text-xs text-danger"
        title={choice.error}
      >
        {choice.label}: unavailable
      </span>
    );
  }
  // A value the URL or the default named but the list no longer has is still
  // what is selected, so it stays visible rather than reading as another.
  const options = [...new Set([...choice.options, ...value])];
  if (!choice.multi) {
    return (
      <label htmlFor={id} className="flex items-center gap-1.5 text-xs text-muted">
        {choice.label}
        <Select
          id={id}
          className="h-8 min-w-32"
          value={value[0] ?? null}
          onValueChange={(v) => onChange([v])}
          options={options.map((o) => ({ value: o, label: o }))}
        />
      </label>
    );
  }
  const summary =
    value.length === 0
      ? "none"
      : value.length === 1
        ? value[0]
        : `${value.length} selected`;
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted">
      <span>{choice.label}</span>
      <Popover
        label={`${choice.label}: ${summary}`}
        className="inline-flex h-8 min-w-32 cursor-pointer items-center justify-between gap-2 border border-border bg-surface px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-primary"
        panelClassName="max-h-72 w-56 overflow-auto"
        align="start"
        trigger={
          <>
            <span className="truncate">{summary}</span>
            <ChevronDown className="h-4 w-4 opacity-70" aria-hidden />
          </>
        }
      >
        <div className="space-y-1.5 p-1">
          {options.map((option) => (
            <Checkbox
              key={option}
              checked={value.includes(option)}
              // The last value stays: an empty pick would fall back to the
              // default on the server, which is not what unticking means.
              disabled={value.length === 1 && value.includes(option)}
              label={option}
              onCheckedChange={(on) =>
                onChange(
                  on
                    ? options.filter((o) => o === option || value.includes(o))
                    : value.filter((v) => v !== option),
                )
              }
            />
          ))}
        </div>
      </Popover>
    </div>
  );
}
