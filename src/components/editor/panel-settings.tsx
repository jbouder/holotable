"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { TimeRangeFilter } from "@/components/dashboard/TimeRangeFilter";
import { useSyncedDraft } from "@/components/editor/use-synced-draft";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { Panel, TimeRange } from "@/lib/ir";
import {
  describeIssue,
  type Parsed,
  parseOptionalNumber,
  parseOptionalText,
  REFRESH_PRESETS_MS,
  withOptions,
} from "@/lib/panel-options";
import { COLOR_TOKENS, type ColorToken } from "@/lib/panels/colors";
import {
  type OptionGroup,
  type TableColumn,
  ValueFormat,
} from "@/lib/panels/presentation";
import { panelKind } from "@/lib/panels/registry";
import type { ThresholdStep } from "@/lib/panels/thresholds";
import { formatSpan } from "@/lib/time-range";
import { cn } from "@/lib/utils";

/**
 * The panel editor's settings beyond its query: the window and cadence a
 * panel may have of its own (#114), and its presentation options grouped by
 * what they change, only those its kind takes (#115).
 */

/** How a change is recorded in the editor's undo stack. */
export interface SettingsIntent {
  action: string;
  /** Consecutive edits sharing a key coalesce into one history entry. */
  key?: string | null;
}

type OnChange = (fn: (p: Panel) => Panel, intent: SettingsIntent) => void;

function Problem({
  id,
  problem,
  hint,
}: {
  id: string;
  problem: string | null;
  hint?: string;
}) {
  if (!problem && !hint) return null;
  return (
    <p id={id} className={cn("mt-1 text-xs", problem ? "text-danger" : "text-muted")}>
      {problem ?? hint}
    </p>
  );
}

// ---------------------------------------------------------------------------
// #114: the panel's own window and cadence
// ---------------------------------------------------------------------------

export function PanelTimingFields({
  panel,
  dashboardRange,
  dashboardRefreshMs,
  onChange,
}: {
  panel: Panel;
  dashboardRange: TimeRange;
  dashboardRefreshMs: number;
  onChange: OnChange;
}) {
  const refreshOptions = REFRESH_PRESETS_MS.map((ms) => ({
    value: String(ms),
    label: `every ${formatSpan(ms)}`,
  }));
  const refresh = panel.refreshIntervalMs;
  if (refresh !== undefined && !refreshOptions.some((o) => o.value === String(refresh))) {
    refreshOptions.push({
      value: String(refresh),
      label: `every ${formatSpan(refresh)}`,
    });
  }

  return (
    <fieldset className="space-y-2 border border-border p-3">
      <legend className="px-1 text-sm font-medium text-muted">Time and refresh</legend>
      <div className="flex flex-wrap items-center gap-3">
        <Checkbox
          checked={panel.timeRange !== undefined}
          label="Own time range"
          onCheckedChange={(on) =>
            onChange((p) => ({ ...p, timeRange: on ? dashboardRange : undefined }), {
              action: on ? "give panel its own time range" : "use dashboard time range",
            })
          }
        />
        {panel.timeRange && (
          <TimeRangeFilter
            value={panel.timeRange}
            onChange={(timeRange) =>
              onChange((p) => ({ ...p, timeRange }), {
                action: "change panel time range",
              })
            }
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Checkbox
          checked={refresh !== undefined}
          label="Own refresh interval"
          onCheckedChange={(on) =>
            onChange(
              (p) => ({ ...p, refreshIntervalMs: on ? dashboardRefreshMs : undefined }),
              {
                action: on
                  ? "give panel its own refresh interval"
                  : "use dashboard refresh interval",
              },
            )
          }
        />
        {refresh !== undefined && (
          <Select
            aria-label="Refresh interval"
            value={String(refresh)}
            onValueChange={(v) =>
              onChange((p) => ({ ...p, refreshIntervalMs: Number(v) }), {
                action: "change panel refresh interval",
              })
            }
            options={refreshOptions}
          />
        )}
      </div>
      <p className="text-xs text-muted">
        Readers see a badge on a panel whose window or refresh differs from the
        dashboard&rsquo;s. A panel&rsquo;s own window wins over the one a reader picks.
      </p>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// #115: presentation options, by group
// ---------------------------------------------------------------------------

const GROUP_TITLES: Record<OptionGroup, string> = {
  stat: "Value",
  number: "Numbers",
  axis: "Y axis",
  legend: "Legend",
  thresholds: "Thresholds",
  table: "Columns",
};

/**
 * The option groups the panel's kind takes, then everything as JSON for the
 * fields no group covers.
 */
export function PanelPresentationFields({
  panel,
  onChange,
}: {
  panel: Panel;
  onChange: OnChange;
}) {
  const kind = panelKind(panel.viz);
  if (!kind.options) return null;
  const groups = kind.optionGroups ?? [];
  return (
    <div className="space-y-3">
      {groups.map((group) => (
        <fieldset key={group} className="space-y-2 border border-border p-3">
          <legend className="px-1 text-sm font-medium text-muted">
            {GROUP_TITLES[group]}
          </legend>
          <OptionGroupFields group={group} panel={panel} onChange={onChange} />
        </fieldset>
      ))}
      <OptionsJson
        // A new kind starts a new draft: the old kind's text is not this one's.
        key={`${panel.id}:${panel.viz}`}
        panel={panel}
        onChange={onChange}
        summary={groups.length > 0 ? "All options (JSON)" : "Options (JSON)"}
        open={groups.length === 0}
      />
    </div>
  );
}

function OptionGroupFields({
  group,
  panel,
  onChange,
}: {
  group: OptionGroup;
  panel: Panel;
  onChange: OnChange;
}) {
  const field = (key: string) => ({ panel, onChange, optionKey: key });
  switch (group) {
    case "stat":
      return (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <TextOption {...field("value")} label="Value column" placeholder="automatic" />
          <BooleanOption {...field("sparkline")} label="Sparkline behind the value" />
        </div>
      );
    case "number":
      return (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <SelectOption
            {...field("decimals")}
            label="Decimals"
            options={[
              { value: "", label: "automatic" },
              ...[0, 1, 2, 3, 4, 5, 6].map((n) => ({
                value: String(n),
                label: String(n),
              })),
            ]}
            parse={(v) => (v === "" ? undefined : Number(v))}
          />
          <TextOption {...field("unit")} label="Unit" placeholder="e.g. req/s" />
          <BooleanOption {...field("compact")} label="Compact (1.2K)" />
        </div>
      );
    case "legend":
      return (
        <SelectOption
          {...field("legend")}
          label="Position"
          options={[
            { value: "", label: "top (default)" },
            { value: "bottom", label: "bottom" },
            { value: "right", label: "right" },
            { value: "none", label: "hidden" },
          ]}
          parse={(v) => (v === "" ? undefined : v)}
        />
      );
    case "axis":
      return <AxisFields panel={panel} onChange={onChange} />;
    case "thresholds":
      return <ThresholdsField panel={panel} onChange={onChange} />;
    case "table":
      return <TableFields panel={panel} onChange={onChange} />;
  }
}

interface OptionFieldProps {
  panel: Panel;
  onChange: OnChange;
  optionKey: string;
}

/** Commit `patch` to the panel's options, or say why it cannot be. */
function commitOptions(
  panel: Panel,
  onChange: OnChange,
  patch: Record<string, unknown>,
  intent: SettingsIntent,
): string | null {
  const edit = withOptions(panel, patch);
  if (!edit.ok) return edit.error;
  onChange((p) => {
    const next = withOptions(p, patch);
    return next.ok ? next.panel : p;
  }, intent);
  return null;
}

/**
 * A typed field over one option: the text is the person's until it parses and
 * the options it makes are valid, and a value from elsewhere replaces it.
 */
function DraftInput<T>({
  id,
  value,
  parse,
  show,
  commit,
  ...input
}: {
  id: string;
  value: T;
  parse: (text: string) => Parsed<T>;
  show: (value: T) => string;
  commit: (value: T) => string | null;
} & Omit<React.ComponentProps<typeof Input>, "value" | "onChange" | "id">) {
  const external = show(value);
  const { draft, setDraft, committed } = useSyncedDraft(external, () => external);
  const [problem, setProblem] = React.useState<string | null>(null);
  return (
    <>
      <Input
        {...input}
        id={id}
        value={draft}
        aria-invalid={problem !== null}
        aria-describedby={problem ? `${id}-problem` : undefined}
        onChange={(e) => {
          const text = e.target.value;
          setDraft(text);
          const parsed = parse(text);
          if (!parsed.ok) {
            setProblem(parsed.error);
            return;
          }
          const error = commit(parsed.value);
          setProblem(error);
          if (error === null) committed(show(parsed.value));
        }}
      />
      <Problem id={`${id}-problem`} problem={problem} />
    </>
  );
}

function TextOption({
  panel,
  onChange,
  optionKey,
  label,
  placeholder,
}: OptionFieldProps & { label: string; placeholder?: string }) {
  const id = `p-opt-${optionKey}`;
  const value = panel.options?.[optionKey];
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <DraftInput
        id={id}
        placeholder={placeholder}
        value={typeof value === "string" ? value : undefined}
        parse={parseOptionalText}
        show={(v) => v ?? ""}
        commit={(v) =>
          commitOptions(
            panel,
            onChange,
            { [optionKey]: v },
            {
              action: `edit ${label.toLowerCase()}`,
              key: `${panel.id}:opt:${optionKey}`,
            },
          )
        }
      />
    </div>
  );
}

function BooleanOption({
  panel,
  onChange,
  optionKey,
  label,
}: OptionFieldProps & { label: string }) {
  const [problem, setProblem] = React.useState<string | null>(null);
  return (
    <div className="flex flex-col justify-end">
      <Checkbox
        className="h-10"
        checked={panel.options?.[optionKey] === true}
        label={label}
        onCheckedChange={(on) =>
          setProblem(
            commitOptions(
              panel,
              onChange,
              // Off is the default, so it is no option at all.
              { [optionKey]: on ? true : undefined },
              { action: `toggle ${label.toLowerCase()}` },
            ),
          )
        }
      />
      <Problem id={`p-opt-${optionKey}-problem`} problem={problem} />
    </div>
  );
}

function SelectOption({
  panel,
  onChange,
  optionKey,
  label,
  options,
  parse,
}: OptionFieldProps & {
  label: string;
  options: { value: string; label: string }[];
  parse: (value: string) => unknown;
}) {
  const id = `p-opt-${optionKey}`;
  const [problem, setProblem] = React.useState<string | null>(null);
  const value = panel.options?.[optionKey];
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Select
        id={id}
        className="w-full"
        value={value === undefined ? "" : String(value)}
        onValueChange={(v) =>
          setProblem(
            commitOptions(
              panel,
              onChange,
              { [optionKey]: parse(v) },
              { action: `change ${label.toLowerCase()}` },
            ),
          )
        }
        options={options}
      />
      <Problem id={`${id}-problem`} problem={problem} />
    </div>
  );
}

/** `yAxis` is one object; each box edits its own field of it. */
function AxisFields({ panel, onChange }: { panel: Panel; onChange: OnChange }) {
  const axis = (panel.options?.yAxis ?? {}) as Record<string, unknown>;
  const commitAxis = (patch: Record<string, unknown>, intent: SettingsIntent) => {
    const next: Record<string, unknown> = { ...axis, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    return commitOptions(
      panel,
      onChange,
      { yAxis: Object.keys(next).length > 0 ? next : undefined },
      intent,
    );
  };
  const numberBox = (key: "min" | "max", label: string) => (
    <div>
      <Label htmlFor={`p-axis-${key}`}>{label}</Label>
      <DraftInput
        id={`p-axis-${key}`}
        inputMode="decimal"
        placeholder="automatic"
        value={typeof axis[key] === "number" ? (axis[key] as number) : undefined}
        parse={parseOptionalNumber}
        show={(v) => (v === undefined ? "" : String(v))}
        commit={(v) =>
          commitAxis(
            { [key]: v },
            { action: `edit y axis ${key}`, key: `${panel.id}:axis:${key}` },
          )
        }
      />
    </div>
  );
  const [problem, setProblem] = React.useState<string | null>(null);
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {numberBox("min", "Min")}
        {numberBox("max", "Max")}
        <div>
          <Label htmlFor="p-axis-label">Title</Label>
          <DraftInput
            id="p-axis-label"
            value={typeof axis.label === "string" ? axis.label : undefined}
            parse={parseOptionalText}
            show={(v) => v ?? ""}
            commit={(v) =>
              commitAxis(
                { label: v },
                { action: "edit y axis title", key: `${panel.id}:axis:label` },
              )
            }
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-4">
        <Checkbox
          checked={axis.log === true}
          label="Log scale"
          onCheckedChange={(on) =>
            setProblem(
              commitAxis({ log: on ? true : undefined }, { action: "toggle log scale" }),
            )
          }
        />
        <Checkbox
          checked={panel.options?.stacked === true}
          label="Stacked"
          onCheckedChange={(on) =>
            setProblem(
              commitOptions(
                panel,
                onChange,
                { stacked: on ? true : undefined },
                { action: "toggle stacked series" },
              ),
            )
          }
        />
      </div>
      <Problem id="p-axis-problem" problem={problem} />
    </div>
  );
}

const COLOR_OPTIONS = (Object.keys(COLOR_TOKENS) as ColorToken[]).map((c) => ({
  value: c,
  label: c,
}));
const STEP_COLORS: ColorToken[] = ["success", "warning", "danger"];

interface StepDraft {
  value: string;
  color: ColorToken;
}

/** Ascending `{ value, color }` steps, edited as rows. */
function ThresholdsField({ panel, onChange }: { panel: Panel; onChange: OnChange }) {
  const steps = (panel.options?.thresholds ?? []) as ThresholdStep[];
  const external = JSON.stringify(steps);
  const { draft, setDraft, committed } = useSyncedDraft<StepDraft[]>(external, () =>
    steps.map((s) => ({ value: String(s.value), color: s.color })),
  );
  const [problem, setProblem] = React.useState<string | null>(null);

  function update(rows: StepDraft[], action: string) {
    setDraft(rows);
    const next: ThresholdStep[] = [];
    for (const row of rows) {
      const parsed = parseOptionalNumber(row.value);
      if (!parsed.ok || parsed.value === undefined) {
        setProblem("Each step needs a number.");
        return;
      }
      next.push({ value: parsed.value, color: row.color });
    }
    const error = commitOptions(
      panel,
      onChange,
      { thresholds: next.length > 0 ? next : undefined },
      { action, key: action === "edit threshold" ? `${panel.id}:thresholds` : null },
    );
    setProblem(error);
    if (error === null) committed(JSON.stringify(next));
  }

  return (
    <div className="space-y-2">
      {draft.map((row, i) => (
        // Steps have no identity but their place in the list.
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
        <div key={i} className="flex items-center gap-2">
          <Input
            aria-label={`Step ${i + 1} value`}
            inputMode="decimal"
            className="w-28"
            value={row.value}
            onChange={(e) =>
              update(
                draft.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)),
                "edit threshold",
              )
            }
          />
          <Select
            aria-label={`Step ${i + 1} color`}
            className="min-w-32"
            value={row.color}
            onValueChange={(color) =>
              update(
                draft.map((r, j) => (j === i ? { ...r, color: color as ColorToken } : r)),
                "change threshold color",
              )
            }
            options={COLOR_OPTIONS}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove step ${i + 1}`}
            onClick={() =>
              update(
                draft.filter((_, j) => j !== i),
                "remove threshold",
              )
            }
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button
        variant="secondary"
        size="sm"
        disabled={draft.length >= 10}
        onClick={() => {
          const last = Number(draft[draft.length - 1]?.value);
          const value = Number.isFinite(last) ? last + 10 : 0;
          update(
            [
              ...draft,
              {
                value: String(value),
                color: STEP_COLORS[Math.min(draft.length, STEP_COLORS.length - 1)],
              },
            ],
            "add threshold",
          );
        }}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        Add step
      </Button>
      <Problem
        id="p-thresholds-problem"
        problem={problem}
        hint="A value takes the color of the last step at or below it; steps go up."
      />
    </div>
  );
}

interface ColumnDraft {
  name: string;
  label: string;
  format: string;
  align: string;
  hidden: boolean;
  /** Fields edited only as JSON, kept as they were. */
  rest: Partial<TableColumn>;
}

const FORMAT_OPTIONS = [
  { value: "", label: "as returned" },
  ...ValueFormat.options.map((f) => ({ value: f, label: f })),
];
const ALIGN_OPTIONS = [
  { value: "", label: "align: default" },
  { value: "left", label: "left" },
  { value: "center", label: "center" },
  { value: "right", label: "right" },
];

function columnDraft(c: TableColumn): ColumnDraft {
  const { name, label, format, align, hidden, ...rest } = c;
  return {
    name,
    label: label ?? "",
    format: format ?? "",
    align: align ?? "",
    hidden: hidden === true,
    rest,
  };
}

function columnFromDraft(d: ColumnDraft): Record<string, unknown> {
  return {
    ...d.rest,
    name: d.name.trim(),
    ...(d.label.trim() ? { label: d.label.trim() } : {}),
    ...(d.format ? { format: d.format } : {}),
    ...(d.align ? { align: d.align } : {}),
    ...(d.hidden ? { hidden: true } : {}),
  };
}

/**
 * A table's columns, in the order they are shown, and its sort. A result
 * column not listed is shown after the listed ones, as it came.
 */
function TableFields({ panel, onChange }: { panel: Panel; onChange: OnChange }) {
  const columns = (panel.options?.columns ?? []) as TableColumn[];
  const external = JSON.stringify(columns);
  const { draft, setDraft, committed } = useSyncedDraft<ColumnDraft[]>(external, () =>
    columns.map(columnDraft),
  );
  const [problem, setProblem] = React.useState<string | null>(null);

  function update(rows: ColumnDraft[], action: string, key: string | null = null) {
    setDraft(rows);
    if (rows.some((r) => r.name.trim() === "")) {
      setProblem("Each column needs the name of a result column.");
      return;
    }
    const next = rows.map(columnFromDraft);
    const error = commitOptions(
      panel,
      onChange,
      { columns: next.length > 0 ? next : undefined },
      { action, key },
    );
    setProblem(error);
    if (error === null) committed(JSON.stringify(next));
  }
  const edit = (i: number, patch: Partial<ColumnDraft>, action: string, key?: string) =>
    update(
      draft.map((r, j) => (j === i ? { ...r, ...patch } : r)),
      action,
      key ?? null,
    );
  const move = (i: number, to: number) => {
    const rows = [...draft];
    const [row] = rows.splice(i, 1);
    rows.splice(to, 0, row);
    update(rows, "reorder table columns");
  };

  const sort = panel.options?.sort as { column: string; order?: string } | undefined;

  return (
    <div className="space-y-2">
      {draft.map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
        <div key={i} className="space-y-2 border-b border-border pb-2">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Input
              aria-label={`Column ${i + 1} name`}
              placeholder="result column"
              value={row.name}
              onChange={(e) =>
                edit(
                  i,
                  { name: e.target.value },
                  "edit column name",
                  `${panel.id}:col:${i}:name`,
                )
              }
            />
            <Input
              aria-label={`Column ${i + 1} header`}
              placeholder="header (defaults to the name)"
              value={row.label}
              onChange={(e) =>
                edit(
                  i,
                  { label: e.target.value },
                  "edit column header",
                  `${panel.id}:col:${i}:label`,
                )
              }
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              aria-label={`Column ${i + 1} format`}
              className="min-w-32"
              value={row.format}
              onValueChange={(format) => edit(i, { format }, "change column format")}
              options={FORMAT_OPTIONS}
            />
            <Select
              aria-label={`Column ${i + 1} alignment`}
              className="min-w-32"
              value={row.align}
              onValueChange={(align) => edit(i, { align }, "change column alignment")}
              options={ALIGN_OPTIONS}
            />
            <Checkbox
              checked={row.hidden}
              label="Hidden"
              onCheckedChange={(hidden) =>
                edit(i, { hidden }, hidden ? "hide column" : "show column")
              }
            />
            <div className="ml-auto flex">
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Move column ${i + 1} up`}
                disabled={i === 0}
                onClick={() => move(i, i - 1)}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Move column ${i + 1} down`}
                disabled={i === draft.length - 1}
                onClick={() => move(i, i + 1)}
              >
                <ArrowDown className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove column ${i + 1}`}
                onClick={() =>
                  update(
                    draft.filter((_, j) => j !== i),
                    "remove table column",
                  )
                }
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      ))}
      <Button
        variant="secondary"
        size="sm"
        disabled={draft.length >= 50}
        onClick={() =>
          setDraft([
            ...draft,
            { name: "", label: "", format: "", align: "", hidden: false, rest: {} },
          ])
        }
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        Add column
      </Button>
      <Problem
        id="p-columns-problem"
        problem={problem}
        hint="Listed columns come first, in this order; the rest follow as the query returns them."
      />
      <div className="grid grid-cols-1 gap-3 pt-1 sm:grid-cols-2">
        <div>
          <Label htmlFor="p-sort-column">Sort by</Label>
          <DraftInput
            id="p-sort-column"
            placeholder="query order"
            value={sort?.column}
            parse={parseOptionalText}
            show={(v) => v ?? ""}
            commit={(column) =>
              commitOptions(
                panel,
                onChange,
                { sort: column ? { ...sort, column } : undefined },
                { action: "change table sort", key: `${panel.id}:sort` },
              )
            }
          />
        </div>
        <div>
          <Label htmlFor="p-sort-order">Order</Label>
          <Select
            id="p-sort-order"
            className="w-full"
            disabled={!sort}
            value={sort?.order ?? "asc"}
            onValueChange={(order) =>
              setProblem(
                commitOptions(
                  panel,
                  onChange,
                  { sort: sort ? { ...sort, order } : undefined },
                  { action: "change table sort order" },
                ),
              )
            }
            options={[
              { value: "asc", label: "ascending" },
              { value: "desc", label: "descending" },
            ]}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * A kind's options as JSON, checked against the kind's schema as it is typed.
 * Only a draft that parses and validates reaches the spec; the draft itself is
 * kept while it is being written, and follows the spec when a control above
 * changes it.
 */
function OptionsJson({
  panel,
  onChange,
  summary,
  open,
}: {
  panel: Panel;
  onChange: OnChange;
  summary: string;
  open: boolean;
}) {
  const schema = panelKind(panel.viz).options;
  const external = JSON.stringify(panel.options ?? {});
  const { draft, setDraft, committed } = useSyncedDraft(external, () =>
    JSON.stringify(panel.options ?? {}, null, 2),
  );
  const [problem, setProblem] = React.useState<string | null>(null);

  function edit(text: string) {
    setDraft(text);
    let value: unknown;
    try {
      value = text.trim() === "" ? {} : JSON.parse(text);
    } catch {
      setProblem("Not valid JSON yet.");
      return;
    }
    const parsed = schema?.safeParse(value);
    if (!parsed?.success) {
      setProblem(describeIssue(parsed?.error.issues[0]));
      return;
    }
    setProblem(null);
    const options = Object.keys(parsed.data).length > 0 ? parsed.data : undefined;
    committed(JSON.stringify(options ?? {}));
    onChange(
      (p) => {
        const { options: _, ...rest } = p;
        return options ? { ...rest, options } : rest;
      },
      { action: "edit panel options", key: `${panel.id}:options` },
    );
  }

  return (
    <details open={open} className="space-y-1">
      <summary className="cursor-pointer text-sm font-medium text-muted">
        {summary}
      </summary>
      <Textarea
        id="p-options"
        aria-label={summary}
        rows={5}
        className="mt-2 font-mono text-xs"
        spellCheck={false}
        value={draft}
        aria-invalid={problem !== null}
        aria-describedby="p-options-help"
        onChange={(e) => edit(e.target.value)}
      />
      <Problem
        id="p-options-help"
        problem={problem}
        hint="Every option this kind takes; Reference → Panel options lists the fields."
      />
    </details>
  );
}
