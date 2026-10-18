"use client";

import * as React from "react";
import { Loader2, Pencil, Plus, X } from "lucide-react";
import { Autocomplete } from "@/components/ui/autocomplete";
import { Button } from "@/components/ui/button";
import { ErrorDisplay } from "@/components/ui/error-display";
import { Input } from "@/components/ui/input";
import type { ApiError } from "@/lib/errors";
import {
  type DuckDbFormState,
  type DuckDbPathsOutcome,
  discoverDuckDbTables,
  duckdbConfigFromFormState,
  duckdbFormStateFromConfig,
  duckdbPathErrors,
  emptyDuckDbFormState,
  listDuckDbPaths,
} from "@/lib/duckdb-form";
import {
  applyDiscovery,
  draftFieldErrors,
  emptyMenu,
  type FieldErrors,
  rememberTable,
  type TableMenu,
  tableRows,
  toggleTable,
  updateTable,
} from "@/lib/source-form";
import type { DuckDbConfig } from "@/lib/sources/kinds/duckdb";
import type { UploadAvailability } from "@/lib/sources/types";
import { DuckDbUploadPicker } from "./duckdb-upload-picker";
import { Field, fieldAria, TableAllowlist } from "./source-form";

/**
 * The DuckDB source form (#573): a path under `DUCKDB_SOURCES_DIR`, picked
 * from what the server lists there, and the same table allowlist the
 * TimescaleDB form has, discovered from the files or the database the path
 * names. With `upload` (#595) the path picker is a file picker instead: the
 * server stores the files under `uploads/` and answers the path, and the
 * form goes on from discovery. No `secret_ref`: there is nothing to log in to. Everything that
 * decides anything lives in `@/lib/duckdb-form` and `@/lib/source-form`; this
 * file is the controls.
 */

/** Upload mode's path error: there is no path to type, only files to send. */
const UPLOAD_FIRST = "Upload the files first.";

export interface DuckDbSourceFormValues {
  id: string;
  name: string;
  config: DuckDbConfig;
}

export interface DuckDbSourceFormInitial {
  id?: string;
  name?: string;
  config?: DuckDbConfig;
}

export function DuckDbSourceForm({
  mode,
  workspaceId,
  submitLabel,
  initial,
  onSubmit,
  onCancel,
  upload,
}: {
  mode: "create" | "edit";
  /** The workspace the path listing and discovery are authorized against. */
  workspaceId: string;
  submitLabel: string;
  initial?: DuckDbSourceFormInitial;
  /** Resolves to the failure to show, or null on success. */
  onSubmit: (values: DuckDbSourceFormValues) => Promise<ApiError | null>;
  onCancel?: () => void;
  /** Make the source from uploaded files (#595), within these bounds. */
  upload?: UploadAvailability;
}) {
  const [id, setId] = React.useState(initial?.id ?? "");
  const [name, setName] = React.useState(initial?.name ?? "");
  const [form, setForm] = React.useState<DuckDbFormState>(() =>
    initial?.config ? duckdbFormStateFromConfig(initial.config) : emptyDuckDbFormState(),
  );
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [error, setError] = React.useState<ApiError | null>(null);
  const [saving, setSaving] = React.useState(false);

  const [menu, setMenu] = React.useState<TableMenu>(emptyMenu);
  const [discovering, setDiscovering] = React.useState(false);
  const [unticked, setUnticked] = React.useState<string[]>([]);

  // What the picker offers: asked once, when the form opens.
  const [paths, setPaths] = React.useState<DuckDbPathsOutcome | null>(null);
  React.useEffect(() => {
    if (upload) return;
    const controller = new AbortController();
    void listDuckDbPaths(workspaceId, { signal: controller.signal }).then((outcome) => {
      if (!controller.signal.aborted) setPaths(outcome);
    });
    return () => controller.abort();
  }, [workspaceId, upload]);

  /** Clear one field's error as soon as it is edited. */
  function clear(field: string) {
    setErrors((current) => {
      if (!(field in current)) return current;
      const { [field]: _cleared, ...rest } = current;
      return rest;
    });
  }

  async function discover(base: DuckDbFormState = form, baseMenu: TableMenu = menu) {
    setError(null);
    const pathErrors = duckdbPathErrors(base.path);
    if (Object.keys(pathErrors).length > 0) {
      setErrors((current) => ({
        ...current,
        ...(upload ? { path: UPLOAD_FIRST } : pathErrors),
      }));
      return;
    }
    setDiscovering(true);
    const outcome = await discoverDuckDbTables({ workspaceId, path: base.path.trim() });
    setDiscovering(false);
    if (!outcome.ok) {
      setError(outcome.error);
      return;
    }
    const applied = applyDiscovery(base, baseMenu, outcome.tables);
    setForm(applied.state);
    setMenu(applied.menu);
    setUnticked(applied.unticked);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const config = duckdbConfigFromFormState(form);
    const found = {
      ...draftFieldErrors({ id: mode === "create" ? id : undefined, name }),
      ...(config.ok ? {} : config.errors),
    };
    if (!config.ok || Object.keys(found).length > 0) {
      setErrors(upload && found.path ? { ...found, path: UPLOAD_FIRST } : found);
      setError({ error: "Some fields still need attention.", kind: "validation" });
      return;
    }
    setErrors({});
    setSaving(true);
    const failure = await onSubmit({
      id: id.trim(),
      name: name.trim(),
      config: config.config,
    });
    setSaving(false);
    if (failure) setError(failure);
  }

  const suggestions = paths?.ok
    ? paths.paths.map((p) => ({
        value: p.name,
        label: p.layout === "directory" ? "Directory of files" : "Database file",
      }))
    : [];
  // The listing's refusal (the root unset or unreadable) is the field's
  // error until the author's own input gives it another.
  const pathError = errors.path ?? (paths && !paths.ok ? paths.error : undefined);
  const rows = tableRows(form, menu);

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {mode === "create" && (
          <Field id="d-id" label="Source id" error={errors.id}>
            <Input
              id="d-id"
              value={id}
              onChange={(e) => {
                setId(e.target.value);
                clear("id");
              }}
              placeholder="lake"
              {...fieldAria("d-id", errors.id)}
            />
          </Field>
        )}
        <Field id="d-name" label="Name" error={errors.name}>
          <Input
            id="d-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              clear("name");
            }}
            placeholder="Request logs"
            {...fieldAria("d-name", errors.name)}
          />
        </Field>
      </div>

      <div className="border-t border-border pt-4">
        {upload ? (
          <DuckDbUploadPicker
            workspaceId={workspaceId}
            limits={upload}
            discovering={discovering}
            discovered={menu.ran}
            error={errors.path}
            onUploaded={(path) => {
              // Straight on to discovery, from the path the server answered.
              const next = { ...form, path, tables: [] };
              setForm(next);
              const fresh = emptyMenu();
              setMenu(fresh);
              setUnticked([]);
              clear("path");
              void discover(next, fresh);
            }}
            onReset={() => {
              setForm((current) => ({ ...current, path: "", tables: [] }));
              setMenu(emptyMenu());
              setUnticked([]);
            }}
          />
        ) : (
          <Field
            id="d-path"
            label="Path"
            error={pathError}
            hint="A directory of Parquet and CSV files, or a .duckdb file, under the server's DUCKDB_SOURCES_DIR."
          >
            <Autocomplete
              id="d-path"
              value={form.path}
              onValueChange={(path) => {
                setForm((current) => ({ ...current, path }));
                clear("path");
              }}
              suggestions={suggestions}
              placeholder={paths === null ? "Loading…" : "Choose a directory or file"}
              autoComplete="off"
              spellCheck={false}
              {...fieldAria("d-path", pathError)}
            />
          </Field>
        )}
      </div>

      <TableAllowlist
        rows={rows}
        errors={errors}
        unticked={unticked}
        where={upload ? "in the uploaded files" : "under this path"}
        empty={
          menu.ran
            ? "No tables under this path: a directory's tables are its Parquet and CSV files."
            : upload
              ? "Upload files, and their tables are discovered here."
              : "Choose a path, then discover the tables this source may read."
        }
        discovering={discovering}
        onDiscover={() => void discover()}
        onToggle={(table) => {
          // Remembered first: unticking must not take the row off the screen.
          setMenu((current) => rememberTable(current, table));
          setForm(toggleTable(form, table));
          setUnticked((current) => current.filter((n) => n !== table.name));
        }}
        onChange={(tableName, patch) => setForm(updateTable(form, tableName, patch))}
      />

      {error && <ErrorDisplay error={error} />}

      <div className="flex gap-2">
        <Button type="submit" busy={saving}>
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
