"use client";

import * as React from "react";
import { Database, Loader2, Pencil, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ErrorDisplay } from "@/components/ui/error-display";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { ApiError } from "@/lib/errors";
import type { CatalogTable, SourceConfig } from "@/lib/registry";
import {
  configFromFormState,
  configTextFromFormState,
  connectionFromFormState,
  discoverSourceTables,
  type FieldErrors,
  type SourceFormState,
  type TableMenu,
  emptyFormState,
  emptyMenu,
  menuAfterDiscovery,
  rememberTable,
  formStateFromConfig,
  formStateFromConfigText,
  draftFieldErrors,
  tableFieldKey,
  tableRows,
  timeFieldOptions,
  toggleTable,
  updateTable,
} from "@/lib/source-form";
import {
  type GrantedSecretRefsState,
  SECRET_REF_GRANTS_VAR,
  readinessIn,
} from "@/lib/secret-refs";
import { SecretRefReadinessLine } from "./secret-ref-status";

/**
 * The source form: connection fields, a discovered table picker, and the JSON
 * escape hatch behind an Advanced toggle.
 *
 * Everything that decides anything — what config the state describes, which
 * field an error belongs to, what the JSON view round-trips, what selecting a
 * table does — lives in `@/lib/source-form` and is tested there. This file is
 * the controls.
 */

export interface SourceFormValues {
  id: string;
  name: string;
  secretRef: string;
  config: SourceConfig;
}

export interface SourceFormInitial {
  id?: string;
  name?: string;
  secretRef?: string;
  config?: SourceConfig;
}

const CHOOSE_SECRET_REF = "Choose the credential reference this source connects with.";

/**
 * The ref the form stands on: the one chosen, or — when nothing is chosen and
 * the workspace is granted exactly one — that one, so the common single-ref
 * install needs no click. Derived rather than set from an effect, so a list
 * that arrives late cannot overwrite a choice.
 */
function effectiveSecretRef(chosen: string, list: GrantedSecretRefsState): string {
  if (chosen) return chosen;
  return list.state === "ready" && list.refs.length === 1 ? list.refs[0].ref : "";
}

export function SourceForm({
  mode,
  workspaceId,
  secretRefs,
  submitLabel,
  initial,
  onSubmit,
  onCancel,
}: {
  mode: "create" | "edit";
  /** The workspace discovery is authorized against. */
  workspaceId: string;
  /** The refs the workspace may use, which the `secret_ref` picker offers. */
  secretRefs: GrantedSecretRefsState;
  submitLabel: string;
  initial?: SourceFormInitial;
  /** Resolves to the failure to show, or null on success. */
  onSubmit: (values: SourceFormValues) => Promise<ApiError | null>;
  onCancel?: () => void;
}) {
  const [id, setId] = React.useState(initial?.id ?? "");
  const [name, setName] = React.useState(initial?.name ?? "");
  const [chosenSecretRef, setSecretRef] = React.useState(initial?.secretRef ?? "");
  const secretRef = effectiveSecretRef(chosenSecretRef, secretRefs);
  const [form, setForm] = React.useState<SourceFormState>(() =>
    initial?.config ? formStateFromConfig(initial.config) : emptyFormState(),
  );
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [error, setError] = React.useState<ApiError | null>(null);
  const [saving, setSaving] = React.useState(false);

  // The Advanced view owns its text while it is open, so nothing re-renders
  // the textarea under the cursor; the form state follows every parse.
  const [advanced, setAdvanced] = React.useState(false);
  const [advancedText, setAdvancedText] = React.useState("");
  const [advancedError, setAdvancedError] = React.useState<string | null>(null);

  const [menu, setMenu] = React.useState<TableMenu>(emptyMenu);
  const [discovering, setDiscovering] = React.useState(false);

  // Missing credentials are reported, never enforced: an unconfigured ref
  // still saves, because the variables are the operator's to set and may land
  // later. A ref that is not granted is refused by the server on save.
  const readiness = secretRef ? readinessIn(secretRefs, secretRef) : null;

  // The granted refs, plus a stored ref that is no longer granted, so editing
  // such a source shows what it names rather than silently picking another.
  const refOptions = [
    ...(secretRefs.state === "ready" ? secretRefs.refs : []).map((r) => ({
      value: r.ref,
      label: r.ref,
    })),
  ];
  if (secretRef && !refOptions.some((o) => o.value === secretRef)) {
    refOptions.push({
      value: secretRef,
      label: secretRefs.state === "ready" ? `${secretRef} (not granted)` : secretRef,
    });
  }
  const noRefsGranted =
    secretRefs.state === "ready" && secretRefs.refs.length === 0 && !secretRef;

  /** Clear one field's error as soon as it is edited. */
  function edit<T>(setter: (value: T) => void, field: string) {
    return (value: T) => {
      setter(value);
      setErrors((current) => {
        if (!(field in current)) return current;
        const { [field]: _cleared, ...rest } = current;
        return rest;
      });
    };
  }

  function openAdvanced() {
    setAdvancedText(configTextFromFormState(form));
    setAdvancedError(null);
    setAdvanced(true);
  }

  function closeAdvanced() {
    setAdvanced(false);
    if (advancedError) {
      // The last text that parsed is what the form state holds; say that the
      // rest was dropped rather than silently reverting the textarea.
      setError({
        error: `Your JSON edits were not applied — ${advancedError}`,
        kind: "validation",
      });
    }
  }

  function editAdvanced(text: string) {
    setAdvancedText(text);
    const parsed = formStateFromConfigText(text);
    if (parsed.ok) {
      setForm(parsed.state);
      setAdvancedError(null);
      setErrors({});
    } else {
      setAdvancedError(parsed.error);
    }
  }

  async function discover() {
    setError(null);
    // Discovery needs the connection and the credentials it is made with, and
    // nothing else: a half-filled name is no reason not to look at a schema.
    const connection = connectionFromFormState(form);
    const blocking = {
      ...(connection.ok ? {} : connection.errors),
      ...secretRefErrors(secretRef),
    };
    if (!connection.ok || Object.keys(blocking).length > 0) {
      setErrors((current) => ({ ...current, ...blocking }));
      return;
    }

    setDiscovering(true);
    const outcome = await discoverSourceTables({
      workspaceId,
      secretRef: secretRef.trim(),
      connection: connection.connection,
    });
    setDiscovering(false);
    if (!outcome.ok) {
      setError(outcome.error);
      return;
    }
    setMenu((current) => menuAfterDiscovery(current, outcome.tables));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    // Text in the open JSON view that has never parsed is not part of the form
    // state, so submitting would quietly save the version before it.
    if (advanced && advancedError) {
      setError({ error: `The JSON is not valid — ${advancedError}`, kind: "validation" });
      return;
    }

    const config = configFromFormState(form);
    const fields = {
      ...draftFieldErrors({ id: mode === "create" ? id : undefined, name }),
      ...secretRefErrors(secretRef),
    };
    const found = { ...fields, ...(config.ok ? {} : config.errors) };
    if (!config.ok || Object.keys(found).length > 0) {
      setErrors(found);
      setError({ error: "Some fields still need attention.", kind: "validation" });
      return;
    }

    setErrors({});
    setSaving(true);
    const failure = await onSubmit({
      id: id.trim(),
      name: name.trim(),
      secretRef: secretRef.trim(),
      config: config.config,
    });
    setSaving(false);
    if (failure) {
      setError(failure);
      return;
    }
    if (mode === "create") {
      setId("");
      setName("");
    }
  }

  const rows = tableRows(form, menu);

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {mode === "create" && (
          <Field id="s-id" label="Source id" error={errors.id}>
            <Input
              id="s-id"
              value={id}
              onChange={(e) => edit(setId, "id")(e.target.value)}
              placeholder="ts-metrics"
              {...fieldAria("s-id", errors.id)}
            />
          </Field>
        )}
        <Field id="s-name" label="Name" error={errors.name}>
          <Input
            id="s-name"
            value={name}
            onChange={(e) => edit(setName, "name")(e.target.value)}
            placeholder="Metrics"
            {...fieldAria("s-name", errors.name)}
          />
        </Field>
        <Field
          id="s-secret"
          label="secret_ref"
          error={errors.secretRef}
          hint="The server resolves credentials for this reference; they are never stored."
        >
          <Select
            id="s-secret"
            className="w-full"
            value={secretRef || null}
            onValueChange={edit(setSecretRef, "secretRef")}
            options={refOptions}
            placeholder={
              secretRefs.state === "loading" ? "Loading…" : "Choose a reference"
            }
            disabled={refOptions.length === 0}
          />
          {noRefsGranted ? (
            <p className="mt-1 text-xs text-warning">
              No credential references are granted to this workspace. An operator declares
              them in <code>{SECRET_REF_GRANTS_VAR}</code>.
            </p>
          ) : readiness ? (
            <SecretRefReadinessLine readiness={readiness} />
          ) : null}
        </Field>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
        <h3 className="text-sm font-medium">Connection</h3>
        <button
          type="button"
          onClick={advanced ? closeAdvanced : openAdvanced}
          className="text-xs text-muted underline-offset-4 hover:text-foreground hover:underline"
        >
          {advanced ? "Back to the form" : "Advanced (JSON)"}
        </button>
      </div>

      {advanced ? (
        <div>
          <Label htmlFor="s-config">Connection + catalog (JSON)</Label>
          <Textarea
            id="s-config"
            rows={16}
            className="font-mono text-xs"
            value={advancedText}
            onChange={(e) => editAdvanced(e.target.value)}
            aria-invalid={Boolean(advancedError)}
          />
          {advancedError ? (
            <p className="mt-1 text-xs text-danger">{advancedError}</p>
          ) : (
            <p className="mt-1 text-xs text-muted">
              Applied to the form as you type. Switch back to keep editing there.
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Field id="s-host" label="Host" error={errors.host} className="sm:col-span-2">
              <Input
                id="s-host"
                value={form.host}
                onChange={(e) =>
                  edit(
                    (host: string) => setForm({ ...form, host }),
                    "host",
                  )(e.target.value)
                }
                placeholder="timescaledb"
                {...fieldAria("s-host", errors.host)}
              />
            </Field>
            <Field id="s-port" label="Port" error={errors.port}>
              <Input
                id="s-port"
                inputMode="numeric"
                value={form.port}
                onChange={(e) =>
                  edit(
                    (port: string) => setForm({ ...form, port }),
                    "port",
                  )(e.target.value)
                }
                {...fieldAria("s-port", errors.port)}
              />
            </Field>
            <Field id="s-database" label="Database" error={errors.database}>
              <Input
                id="s-database"
                value={form.database}
                onChange={(e) =>
                  edit(
                    (database: string) => setForm({ ...form, database }),
                    "database",
                  )(e.target.value)
                }
                placeholder="holotable"
                {...fieldAria("s-database", errors.database)}
              />
            </Field>
            <Field id="s-schema" label="Schema" error={errors.schema}>
              <Input
                id="s-schema"
                value={form.schema}
                onChange={(e) =>
                  edit(
                    (schema: string) => setForm({ ...form, schema }),
                    "schema",
                  )(e.target.value)
                }
                placeholder="public"
                {...fieldAria("s-schema", errors.schema)}
              />
            </Field>
            <div className="flex items-end pb-2 sm:col-span-2">
              <Checkbox
                id="s-ssl"
                checked={form.ssl}
                onCheckedChange={(ssl) => setForm({ ...form, ssl })}
                label="Connect over SSL"
              />
            </div>
          </div>

          <div className="space-y-2 border-t border-border pt-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium">Tables</h3>
                <p className="text-xs text-muted">
                  The allowlist: only the tables ticked here may be referenced by any
                  query.
                </p>
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void discover()}
                disabled={discovering}
              >
                {discovering ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Database className="h-4 w-4" />
                )}
                Discover tables
              </Button>
            </div>
            {errors.tables && <p className="text-xs text-danger">{errors.tables}</p>}

            {rows.length === 0 ? (
              <p className="border border-dashed border-border px-3 py-6 text-center text-sm text-muted">
                {menu.ran
                  ? `No tables visible to ${secretRef} in schema ${form.schema}.`
                  : "Fill in the connection, then discover the tables this source may read."}
              </p>
            ) : (
              <ul className="space-y-2">
                {rows.map((row, index) => (
                  <TableRowItem
                    key={row.table.name}
                    row={row}
                    error={errors[tableFieldKey(index, "name")]}
                    onToggle={() => {
                      // Remembered first: unticking must not take the row —
                      // and its column list — off the screen.
                      setMenu((current) => rememberTable(current, row.table));
                      setForm(toggleTable(form, row.table));
                    }}
                    onChange={(patch) =>
                      setForm(updateTable(form, row.table.name, patch))
                    }
                  />
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {error && <ErrorDisplay error={error} />}

      <div className="flex gap-2">
        <Button type="submit" disabled={saving}>
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : mode === "create" ? (
            <Plus className="h-4 w-4" />
          ) : (
            <Pencil className="h-4 w-4" />
          )}
          {submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" variant="secondary" disabled={saving} onClick={onCancel}>
            <X className="h-4 w-4" /> Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

/**
 * The attributes that point a screen reader at a field's error text. Spread
 * onto the control; {@link Field} renders the message under the matching id.
 */
function fieldAria(id: string, error?: string) {
  return {
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error ? `${id}-error` : undefined,
  };
}

function Field({
  id,
  label,
  error,
  hint,
  className,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1 text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

/** One table: ticked or not, and — once ticked — its time column and note. */
function TableRowItem({
  row,
  error,
  onToggle,
  onChange,
}: {
  row: { table: CatalogTable; selected: boolean; discovered: boolean };
  error?: string;
  onToggle: () => void;
  onChange: (patch: Partial<CatalogTable>) => void;
}) {
  const { table, selected, discovered } = row;
  const options = timeFieldOptions(table);

  return (
    <li className="border border-border bg-surface px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <Checkbox
          checked={selected}
          onCheckedChange={onToggle}
          label={
            <span>
              <span className="font-medium">{table.name}</span>
              <span className="ml-2 text-xs text-muted">
                {table.columns.length} column{table.columns.length === 1 ? "" : "s"}
              </span>
            </span>
          }
        />
        {!discovered && (
          <span className="text-xs text-muted" title="Not seen in the last discovery">
            not discovered
          </span>
        )}
      </div>
      <p className="mt-1 truncate pl-6 text-xs text-muted" title={columnSummary(table)}>
        {columnSummary(table)}
      </p>
      {error && <p className="mt-1 pl-6 text-xs text-danger">{error}</p>}
      {selected && (
        <div className="mt-2 grid gap-3 pl-6 sm:grid-cols-2">
          <div>
            <Label htmlFor={`tf-${table.name}`}>Time column</Label>
            <Select
              id={`tf-${table.name}`}
              className="w-full"
              value={table.timeField ?? ""}
              onValueChange={(timeField) => onChange({ timeField })}
              options={[
                { value: "", label: "None" },
                ...options.columns.map((column) => ({
                  value: column.name,
                  label: `${column.name} — ${column.type}`,
                })),
              ]}
            />
            {options.fellBack && (
              <p className="mt-1 text-xs text-muted">
                No timestamp column here — every column is offered.
              </p>
            )}
          </div>
          <div>
            <Label htmlFor={`td-${table.name}`}>Description (optional)</Label>
            <Input
              id={`td-${table.name}`}
              value={table.description ?? ""}
              onChange={(e) => onChange({ description: e.target.value })}
              placeholder="What one row means"
            />
          </div>
        </div>
      )}
    </li>
  );
}

function columnSummary(table: CatalogTable): string {
  return table.columns.map((column) => `${column.name} ${column.type}`).join(", ");
}

/**
 * The `secret_ref` field's error, if any. An empty choice gets a sentence of
 * its own; anything else is checked against the `SourceDraft` field, as the
 * other fields are.
 */
function secretRefErrors(secretRef: string): FieldErrors {
  return secretRef ? draftFieldErrors({ secretRef }) : { secretRef: CHOOSE_SECRET_REF };
}
