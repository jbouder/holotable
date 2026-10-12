"use client";

import * as React from "react";
import { Loader2, Pencil, Plus, Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ErrorDisplay } from "@/components/ui/error-display";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { ApiError } from "@/lib/errors";
import {
  discoverLokiLabelMenu,
  discoverLokiValues,
  emptyLabelMenu,
  emptyLokiFormState,
  type FieldErrors,
  isLabelSelected,
  type LabelMenu,
  type LokiAuth,
  type LokiFormState,
  lokiConfigFromFormState,
  lokiConfigText,
  lokiFormStateFromConfig,
  lokiFormStateFromConfigText,
  needsSecretRef,
  searchLabelMenu,
  toggleLabel,
  withLabelValues,
} from "@/lib/loki-form";
import { draftFieldErrors } from "@/lib/source-form";
import {
  type GrantedSecretRefsState,
  readinessIn,
  SECRET_REF_GRANTS_VAR,
} from "@/lib/secret-refs";
import { type LokiConfig, MAX_LABEL_VALUES, MAX_LABELS } from "@/lib/sources/kinds/loki";
import { effectiveSecretRef, Field, fieldAria, secretRefErrors } from "./source-form";
import { SecretRefReadinessLine } from "./secret-ref-status";

/**
 * The Loki source form (#563): the endpoint's URL and auth, a searched label
 * menu from discovery, each ticked label's values as hints, and the optional
 * tenant label. Everything that decides anything lives in `@/lib/loki-form`
 * and is tested there; this file is the controls, laid out as the Prometheus
 * form's are.
 */

export interface LokiSourceFormValues {
  id: string;
  name: string;
  /** Null exactly when the auth is `none`. */
  secretRef: string | null;
  config: LokiConfig;
}

export interface LokiSourceFormInitial {
  id?: string;
  name?: string;
  secretRef?: string | null;
  config?: LokiConfig;
}

const AUTH_OPTIONS: { value: LokiAuth; label: string }[] = [
  { value: "bearer", label: "Bearer token" },
  { value: "basic", label: "User name and password" },
  { value: "none", label: "None (in-cluster endpoint)" },
];

export function LokiSourceForm({
  mode,
  workspaceId,
  secretRefs,
  submitLabel,
  initial,
  onSubmit,
  onCancel,
}: {
  mode: "create" | "edit";
  workspaceId: string;
  secretRefs: GrantedSecretRefsState;
  submitLabel: string;
  initial?: LokiSourceFormInitial;
  onSubmit: (values: LokiSourceFormValues) => Promise<ApiError | null>;
  onCancel?: () => void;
}) {
  const [id, setId] = React.useState(initial?.id ?? "");
  const [name, setName] = React.useState(initial?.name ?? "");
  const [chosenSecretRef, setSecretRef] = React.useState(initial?.secretRef ?? "");
  const [form, setForm] = React.useState<LokiFormState>(() =>
    initial?.config ? lokiFormStateFromConfig(initial.config) : emptyLokiFormState(),
  );
  const usesRef = needsSecretRef(form.auth);
  const secretRef = usesRef ? effectiveSecretRef(chosenSecretRef, secretRefs) : "";
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [error, setError] = React.useState<ApiError | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [advanced, setAdvanced] = React.useState(false);
  const [advancedText, setAdvancedText] = React.useState("");
  const [advancedError, setAdvancedError] = React.useState<string | null>(null);
  const [menu, setMenu] = React.useState<LabelMenu>(emptyLabelMenu);
  const [query, setQuery] = React.useState("");
  const [discovering, setDiscovering] = React.useState(false);
  // The labels whose values are being asked for, so each row can say so.
  const [asking, setAsking] = React.useState<ReadonlySet<string>>(new Set());

  const readiness = usesRef && secretRef ? readinessIn(secretRefs, secretRef) : null;
  const refOptions = (secretRefs.state === "ready" ? secretRefs.refs : []).map((r) => ({
    value: r.ref,
    label: r.ref,
  }));
  if (secretRef && !refOptions.some((o) => o.value === secretRef)) {
    refOptions.push({
      value: secretRef,
      label: secretRefs.state === "ready" ? `${secretRef} (not granted)` : secretRef,
    });
  }

  function clear(field: string) {
    setErrors((current) => {
      if (!(field in current)) return current;
      const { [field]: _cleared, ...rest } = current;
      return rest;
    });
  }

  function discoveryInput() {
    return {
      workspaceId,
      url: form.url.trim(),
      auth: form.auth,
      secretRef: secretRef || null,
    };
  }

  function discoveryBlockers(): FieldErrors {
    return {
      ...(form.url.trim() ? {} : { url: "Enter the endpoint's URL first." }),
      ...(usesRef ? secretRefErrors(secretRef) : {}),
    };
  }

  async function discover() {
    setError(null);
    const blocking = discoveryBlockers();
    if (Object.keys(blocking).length > 0) {
      setErrors((current) => ({ ...current, ...blocking }));
      return;
    }
    setDiscovering(true);
    const outcome = await discoverLokiLabelMenu(discoveryInput());
    setDiscovering(false);
    if (!outcome.ok) {
      setError(outcome.error);
      return;
    }
    setMenu({ ran: true, labels: outcome.value });
  }

  async function pick(name: string) {
    clear("labels");
    const selecting = !isLabelSelected(form, name);
    setForm((current) => toggleLabel(current, name));
    if (!selecting) return;
    // Ticking a label is what asks the endpoint for its values.
    setAsking((current) => new Set(current).add(name));
    const outcome = await discoverLokiValues(discoveryInput(), name);
    setAsking((current) => {
      const next = new Set(current);
      next.delete(name);
      return next;
    });
    if (outcome.ok) setForm((current) => withLabelValues(current, name, outcome.value));
    else setError(outcome.error);
  }

  function openAdvanced() {
    setAdvancedText(lokiConfigText(form));
    setAdvancedError(null);
    setAdvanced(true);
  }

  function editAdvanced(text: string) {
    setAdvancedText(text);
    const parsed = lokiFormStateFromConfigText(text);
    if (parsed.ok) {
      setForm(parsed.state);
      setAdvancedError(null);
      setErrors({});
    } else {
      setAdvancedError(parsed.error);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (advanced && advancedError) {
      setError({ error: `The JSON is not valid — ${advancedError}`, kind: "validation" });
      return;
    }
    const config = lokiConfigFromFormState(form);
    const found = {
      ...draftFieldErrors({ id: mode === "create" ? id : undefined, name }),
      ...(usesRef ? secretRefErrors(secretRef) : {}),
      ...(config.ok ? {} : config.errors),
    };
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
      secretRef: usesRef ? secretRef.trim() : null,
      config: config.config,
    });
    setSaving(false);
    if (failure) setError(failure);
  }

  const matches = searchLabelMenu(menu, query).filter((l) => !isLabelSelected(form, l));
  const tenantCandidates = form.labels.map((l) => l.name);

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {mode === "create" && (
          <Field id="l-id" label="Source id" error={errors.id}>
            <Input
              id="l-id"
              value={id}
              onChange={(e) => {
                setId(e.target.value);
                clear("id");
              }}
              placeholder="loki-prod"
              {...fieldAria("l-id", errors.id)}
            />
          </Field>
        )}
        <Field id="l-name" label="Name" error={errors.name}>
          <Input
            id="l-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              clear("name");
            }}
            placeholder="Production logs"
            {...fieldAria("l-name", errors.name)}
          />
        </Field>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
        <h3 className="text-sm font-medium">Endpoint</h3>
        <button
          type="button"
          onClick={advanced ? () => setAdvanced(false) : openAdvanced}
          className="text-xs text-muted underline-offset-4 hover:text-foreground hover:underline"
        >
          {advanced ? "Back to the form" : "Advanced (JSON)"}
        </button>
      </div>

      {advanced ? (
        <div>
          <Label htmlFor="l-config">Endpoint + catalog (JSON)</Label>
          <Textarea
            id="l-config"
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
          <div className="grid gap-3 sm:grid-cols-3">
            <Field
              id="l-url"
              label="URL"
              error={errors.url}
              hint="The base the Loki HTTP API answers under, such as https://loki.example.com."
              className="sm:col-span-3"
            >
              <Input
                id="l-url"
                value={form.url}
                onChange={(e) => {
                  setForm({ ...form, url: e.target.value });
                  clear("url");
                }}
                placeholder="https://loki.example.com"
                {...fieldAria("l-url", errors.url)}
              />
            </Field>
            <Field id="l-auth" label="Authentication">
              <Select
                id="l-auth"
                className="w-full"
                value={form.auth}
                onValueChange={(auth) => setForm({ ...form, auth: auth as LokiAuth })}
                options={AUTH_OPTIONS}
              />
            </Field>
            {usesRef ? (
              <Field
                id="l-secret"
                label="secret_ref"
                error={errors.secretRef}
                hint={
                  form.auth === "bearer"
                    ? "The server reads <REF>_TOKEN; it is never stored."
                    : "The server reads <REF>_USERNAME and <REF>_PASSWORD; they are never stored."
                }
                className="sm:col-span-2"
              >
                <Select
                  id="l-secret"
                  className="w-full"
                  value={secretRef || null}
                  onValueChange={(value) => {
                    setSecretRef(value);
                    clear("secretRef");
                  }}
                  options={refOptions}
                  placeholder={
                    secretRefs.state === "loading" ? "Loading…" : "Choose a reference"
                  }
                  disabled={refOptions.length === 0}
                />
                {secretRefs.state === "ready" &&
                secretRefs.refs.length === 0 &&
                !secretRef ? (
                  <p className="mt-1 text-xs text-warning">
                    No credential references are granted to this workspace. An operator
                    declares them in <code>{SECRET_REF_GRANTS_VAR}</code>.
                  </p>
                ) : readiness ? (
                  <SecretRefReadinessLine readiness={readiness} />
                ) : null}
              </Field>
            ) : (
              <p className="self-end pb-2 text-xs text-muted sm:col-span-2">
                No credentials are sent. The endpoint must be in the operator&rsquo;s{" "}
                <code>SOURCE_URL_ALLOWLIST</code> if it is not public, and every workspace
                may reach what that list names.
              </p>
            )}
          </div>

          <div className="space-y-2 border-t border-border pt-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium">Labels</h3>
                <p className="text-xs text-muted">
                  The allowlist: every stream selector must match one of the labels ticked
                  here exactly. {form.labels.length} of at most {MAX_LABELS} selected.
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
                  <Search className="h-4 w-4" />
                )}
                Discover labels
              </Button>
            </div>
            {errors.labels && <p className="text-xs text-danger">{errors.labels}</p>}

            {form.labels.length > 0 && (
              <ul className="space-y-1">
                {form.labels.map((label) => (
                  <li
                    key={label.name}
                    className="flex flex-wrap items-center gap-2 border border-border bg-surface px-3 py-1.5"
                  >
                    <Checkbox
                      checked
                      onCheckedChange={() => void pick(label.name)}
                      label={<span className="font-mono text-xs">{label.name}</span>}
                    />
                    <Badge>
                      {label.values.length}
                      {label.values.length >= MAX_LABEL_VALUES ? "+" : ""} value
                      {label.values.length === 1 ? "" : "s"}
                    </Badge>
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-xs text-muted"
                      title={label.values.join(", ")}
                    >
                      {asking.has(label.name) ? (
                        <Loader2 className="inline h-3 w-3 animate-spin" />
                      ) : label.values.length > 0 ? (
                        label.values.join(", ")
                      ) : (
                        "no values seen yet"
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {menu.ran && (
              <div className="space-y-2">
                <Input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`Search ${menu.labels.length} labels by name`}
                  aria-label="Search the discovered labels"
                />
                {matches.length === 0 ? (
                  <p className="border border-dashed border-border px-3 py-4 text-center text-sm text-muted">
                    {menu.labels.length === 0
                      ? "The endpoint has no streams in the discovery window."
                      : query.trim()
                        ? `No label matches “${query.trim()}”.`
                        : "Every discovered label is selected."}
                  </p>
                ) : (
                  <ul className="max-h-72 space-y-1 overflow-auto">
                    {matches.map((name) => (
                      <li key={name} className="border border-border px-3 py-1.5">
                        <Checkbox
                          checked={false}
                          onCheckedChange={() => void pick(name)}
                          label={<span className="font-mono text-xs">{name}</span>}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {!menu.ran && form.labels.length === 0 && (
              <p className="border border-dashed border-border px-3 py-6 text-center text-sm text-muted">
                Fill in the endpoint, then discover the stream labels this source may
                select on.
              </p>
            )}
          </div>

          <div className="grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
            <Field
              id="l-tenant-label"
              label="Tenant label (optional)"
              error={errors["rowFilter.label"]}
              hint={
                tenantCandidates.length > 0
                  ? `Narrows every stream selector to the viewer's own streams. Selected: ${tenantCandidates.join(", ")}.`
                  : "Narrows every stream selector to streams whose label equals the viewer's claim."
              }
            >
              <Input
                id="l-tenant-label"
                value={form.rowFilterLabel}
                onChange={(e) => {
                  setForm({ ...form, rowFilterLabel: e.target.value });
                  clear("rowFilter.label");
                }}
                placeholder="tenant"
                {...fieldAria("l-tenant-label", errors["rowFilter.label"])}
              />
            </Field>
            <Field id="l-tenant-claim" label="Claim" error={errors["rowFilter.claim"]}>
              <Input
                id="l-tenant-claim"
                value={form.rowFilterClaim}
                onChange={(e) => {
                  setForm({ ...form, rowFilterClaim: e.target.value });
                  clear("rowFilter.claim");
                }}
                placeholder="sub"
                {...fieldAria("l-tenant-claim", errors["rowFilter.claim"])}
              />
            </Field>
          </div>
        </>
      )}

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
