"use client";

import * as React from "react";
import { Plus, X } from "lucide-react";
import { useSyncedDraft } from "@/components/editor/use-synced-draft";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { type ApiError, apiErrorFromThrown, readApiError } from "@/lib/errors";
import { Variable, isSqlQuery } from "@/lib/ir";
import { type SourceKindName, sourceKind } from "@/lib/sources/registry";
import { describeIssue } from "@/lib/panel-options";
import type { VariableValues } from "@/lib/sql/variables";
import { defaultValue } from "@/lib/variable-selection";

/**
 * The dashboard's variables (#67), in the editor: what panel SQL may reference
 * as `:name`, and what a viewer may pick for each. Every value is only ever a
 * bound parameter, and the server checks each pick against the declaration.
 */

interface VariableDraft {
  name: string;
  label: string;
  type: "enum" | "query";
  /** One value per line. */
  values: string;
  sourceId: string;
  sql: string;
  /** A label-values query's label, for a Prometheus source (#388). */
  labelName: string;
  /** And the selector its values are drawn from; empty for the allowlist. */
  match: string;
  multi: boolean;
  /** Comma-separated for a multi-value variable. */
  default: string;
}

function toDraft(v: Variable): VariableDraft {
  return {
    name: v.name,
    label: v.label ?? "",
    type: v.type,
    values: (v.values ?? []).join("\n"),
    sourceId: v.query?.sourceId ?? "",
    sql: v.query && isSqlQuery(v.query) ? v.query.sql : "",
    labelName: v.query && "label" in v.query ? v.query.label : "",
    match: v.query && "label" in v.query ? (v.query.match ?? "") : "",
    multi: v.multi === true,
    default: v.default === undefined ? "" : [v.default].flat().join(", "),
  };
}

/** Which query a source answers: a SELECT, or a label's values. */
type QueryShape = "sql" | "labels";

/**
 * The declaration a draft row makes, unvalidated. The query's shape is its
 * source's language, so a row pointed at a Prometheus source declares label
 * values and one pointed at a SQL source declares a SELECT, whatever the row
 * held before.
 */
function fromDraft(d: VariableDraft, shape: QueryShape): Record<string, unknown> {
  const defaults = d.multi
    ? d.default
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : d.default.trim();
  return {
    name: d.name.trim(),
    ...(d.label.trim() ? { label: d.label.trim() } : {}),
    type: d.type,
    ...(d.type === "enum"
      ? {
          values: d.values
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
        }
      : {
          query:
            shape === "labels"
              ? {
                  sourceId: d.sourceId,
                  label: d.labelName.trim(),
                  ...(d.match.trim() ? { match: d.match.trim() } : {}),
                }
              : { sourceId: d.sourceId, sql: d.sql.trim() },
        }),
    ...(d.multi ? { multi: true } : {}),
    ...((Array.isArray(defaults) ? defaults.length > 0 : defaults !== "")
      ? { default: defaults }
      : {}),
  };
}

const EMPTY: VariableDraft = {
  name: "",
  label: "",
  type: "enum",
  values: "",
  sourceId: "",
  sql: "",
  labelName: "",
  match: "",
  multi: false,
  default: "",
};

export function VariablesEditor({
  variables,
  sources,
  onChange,
}: {
  variables: Variable[] | undefined;
  /** With its kind, so a query variable is written in its source's terms (#388). */
  sources: { id: string; name: string; kind?: SourceKindName }[];
  onChange: (variables: Variable[] | undefined, action: string, key?: string) => void;
}) {
  const list = variables ?? [];
  const shapeOf = (row: VariableDraft): QueryShape => {
    const kind = sources.find((s) => s.id === row.sourceId)?.kind;
    if (kind) return sourceKind(kind).language === "promql" ? "labels" : "sql";
    // A removed source: keep what the row was written as.
    return row.labelName && !row.sql ? "labels" : "sql";
  };
  const { draft, setDraft, committed } = useSyncedDraft<VariableDraft[]>(
    JSON.stringify(list),
    () => list.map(toDraft),
  );
  const [problem, setProblem] = React.useState<string | null>(null);

  function update(rows: VariableDraft[], action: string, key?: string) {
    setDraft(rows);
    const parsed: Variable[] = [];
    const names = new Set<string>();
    for (const [i, row] of rows.entries()) {
      const result = Variable.safeParse(fromDraft(row, shapeOf(row)));
      if (!result.success) {
        setProblem(`Variable ${i + 1}: ${describeIssue(result.error.issues[0])}`);
        return;
      }
      if (names.has(result.data.name)) {
        setProblem(`Variable ${i + 1}: "${result.data.name}" is declared twice.`);
        return;
      }
      names.add(result.data.name);
      parsed.push(result.data);
    }
    setProblem(null);
    committed(JSON.stringify(parsed));
    onChange(parsed.length > 0 ? parsed : undefined, action, key);
  }
  const edit = (i: number, patch: Partial<VariableDraft>, action: string, key?: string) =>
    update(
      draft.map((r, j) => (j === i ? { ...r, ...patch } : r)),
      action,
      key,
    );

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        Reference a variable in panel SQL as <code>:name</code>; a multi-value one as{" "}
        <code>col = ANY(:name)</code>. In PromQL it is a matcher&rsquo;s value,{" "}
        <code>{'{host=":host"}'}</code>, or <code>{'{host=~":host"}'}</code> for several.
        A value is never written into a query as text, and the server refuses any value
        the variable does not allow.
      </p>
      {draft.map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional while being named
        <fieldset key={i} className="space-y-2 border border-border p-3">
          <legend className="px-1 text-sm font-medium text-muted">
            {row.name ? `:${row.name}` : `Variable ${i + 1}`}
          </legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div>
              <Label htmlFor={`var-${i}-name`}>Name</Label>
              <Input
                id={`var-${i}-name`}
                placeholder="host"
                value={row.name}
                onChange={(e) =>
                  edit(i, { name: e.target.value }, "edit variable name", `var:${i}:name`)
                }
              />
            </div>
            <div>
              <Label htmlFor={`var-${i}-label`}>Label</Label>
              <Input
                id={`var-${i}-label`}
                placeholder="defaults to the name"
                value={row.label}
                onChange={(e) =>
                  edit(
                    i,
                    { label: e.target.value },
                    "edit variable label",
                    `var:${i}:label`,
                  )
                }
              />
            </div>
            <div>
              <Label htmlFor={`var-${i}-type`}>Values from</Label>
              <Select
                id={`var-${i}-type`}
                className="w-full"
                value={row.type}
                onValueChange={(type) =>
                  edit(
                    i,
                    {
                      type: type as VariableDraft["type"],
                      sourceId: row.sourceId || sources[0]?.id || "",
                    },
                    "change variable type",
                  )
                }
                options={[
                  { value: "enum", label: "a list" },
                  { value: "query", label: "a query or label values" },
                ]}
              />
            </div>
          </div>
          {row.type === "enum" ? (
            <div>
              <Label htmlFor={`var-${i}-values`}>Values, one per line</Label>
              <Textarea
                id={`var-${i}-values`}
                rows={3}
                className="font-mono text-xs"
                value={row.values}
                onChange={(e) =>
                  edit(
                    i,
                    { values: e.target.value },
                    "edit variable values",
                    `var:${i}:values`,
                  )
                }
              />
            </div>
          ) : (
            <div className="space-y-2">
              <div>
                <Label htmlFor={`var-${i}-source`}>Source</Label>
                <Select
                  id={`var-${i}-source`}
                  className="w-full"
                  value={row.sourceId}
                  onValueChange={(sourceId) =>
                    edit(i, { sourceId }, "change variable source")
                  }
                  options={sources.map((s) => ({ value: s.id, label: s.name }))}
                />
              </div>
              {shapeOf(row) === "labels" ? (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <div>
                    <Label htmlFor={`var-${i}-label-name`}>Label values of</Label>
                    <Input
                      id={`var-${i}-label-name`}
                      placeholder="instance"
                      spellCheck={false}
                      className="font-mono text-xs"
                      value={row.labelName}
                      onChange={(e) =>
                        edit(
                          i,
                          { labelName: e.target.value },
                          "edit variable label",
                          `var:${i}:labelName`,
                        )
                      }
                    />
                  </div>
                  <div>
                    <Label htmlFor={`var-${i}-match`}>From series (optional)</Label>
                    <Input
                      id={`var-${i}-match`}
                      placeholder="every allowlisted metric"
                      spellCheck={false}
                      className="font-mono text-xs"
                      value={row.match}
                      onChange={(e) =>
                        edit(
                          i,
                          { match: e.target.value },
                          "edit variable selector",
                          `var:${i}:match`,
                        )
                      }
                    />
                  </div>
                </div>
              ) : (
                <div>
                  <Label htmlFor={`var-${i}-sql`}>
                    SQL (its first column is the values; no time filter, no variables)
                  </Label>
                  <Textarea
                    id={`var-${i}-sql`}
                    rows={3}
                    className="font-mono text-xs"
                    spellCheck={false}
                    placeholder="SELECT DISTINCT host FROM metrics.system_metrics ORDER BY 1"
                    value={row.sql}
                    onChange={(e) =>
                      edit(
                        i,
                        { sql: e.target.value },
                        "edit variable query",
                        `var:${i}:sql`,
                      )
                    }
                  />
                </div>
              )}
            </div>
          )}
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-48 flex-1">
              <Label htmlFor={`var-${i}-default`}>
                Default{row.multi ? " (comma-separated)" : ""}
              </Label>
              <Input
                id={`var-${i}-default`}
                placeholder="the first value"
                value={row.default}
                onChange={(e) =>
                  edit(
                    i,
                    { default: e.target.value },
                    "edit variable default",
                    `var:${i}:default`,
                  )
                }
              />
            </div>
            <Checkbox
              className="h-10"
              checked={row.multi}
              label="Several values"
              onCheckedChange={(multi) =>
                edit(i, { multi }, multi ? "allow several values" : "allow one value")
              }
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove variable ${row.name || i + 1}`}
              onClick={() =>
                update(
                  draft.filter((_, j) => j !== i),
                  "remove variable",
                )
              }
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </fieldset>
      ))}
      <Button
        variant="secondary"
        size="sm"
        disabled={draft.length >= 10}
        onClick={() => setDraft([...draft, EMPTY])}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        Add variable
      </Button>
      {problem && <p className="text-xs text-danger">{problem}</p>}
    </div>
  );
}

/**
 * The values the editor's previews bind (#67): each variable's default, or
 * its first allowed value. A query variable's values are asked of the server,
 * which runs its guarded SELECT as the author. `error` is the first variable
 * whose values could not be read.
 */
export function usePreviewValues(variables: Variable[] | undefined): {
  values: VariableValues;
  error: ApiError | null;
  /** The values are for these declarations; until then a preview should wait. */
  ready: boolean;
} {
  const key = JSON.stringify(variables ?? []);
  const [state, setState] = React.useState<{
    key: string;
    values: VariableValues;
    error: ApiError | null;
  }>({ key: "", values: {}, error: null });

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the serialized declarations
  React.useEffect(() => {
    const list = variables ?? [];
    let cancelled = false;
    void (async () => {
      const values: Record<string, VariableValues[string]> = {};
      let error: ApiError | null = null;
      for (const v of list) {
        let options: string[] = v.values ?? [];
        if (v.type === "query") {
          try {
            const res = await fetch("/api/variables/options", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ variable: v }),
            });
            if (res.ok) options = ((await res.json()) as { options: string[] }).options;
            else error ??= await readApiError(res);
          } catch (err) {
            error ??= apiErrorFromThrown(err);
          }
        }
        const value = defaultValue(v, options);
        if (value !== undefined) values[v.name] = value;
      }
      if (!cancelled) setState({ key, values, error });
    })();
    return () => {
      cancelled = true;
    };
  }, [key]);

  // `state.values` is a new object only when a fetch lands, so a preview keyed
  // on it re-runs when the values may have changed and not on every render.
  // With nothing declared there is nothing to wait for.
  if (!variables?.length) return NONE_DECLARED;
  return state.key === key ? { ...state, ready: true } : LOADING;
}

const NONE_DECLARED = { values: {}, error: null, ready: true } as const;
const LOADING = { values: {}, error: null, ready: false } as const;
