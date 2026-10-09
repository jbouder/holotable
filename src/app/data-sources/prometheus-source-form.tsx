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
  type DiscoveredMetric,
  discoverPrometheusLabels,
  discoverPrometheusMetrics,
  emptyMetricMenu,
  emptyPrometheusFormState,
  type FieldErrors,
  isSelected,
  type MetricMenu,
  needsSecretRef,
  type PrometheusAuth,
  type PrometheusFormState,
  prometheusConfigFromFormState,
  prometheusConfigText,
  prometheusFormStateFromConfig,
  prometheusFormStateFromConfigText,
  searchMenu,
  sharedLabels,
  toggleMetric,
  withLabels,
} from "@/lib/prometheus-form";
import { draftFieldErrors } from "@/lib/source-form";
import {
  type GrantedSecretRefsState,
  readinessIn,
  SECRET_REF_GRANTS_VAR,
} from "@/lib/secret-refs";
import { MAX_METRICS, type PrometheusConfig } from "@/lib/sources/kinds/prometheus";
import { effectiveSecretRef, Field, fieldAria, secretRefErrors } from "./source-form";
import { SecretRefReadinessLine } from "./secret-ref-status";

/**
 * The Prometheus source form (#386): the endpoint's URL and auth, a searched
 * metric menu from discovery, and the optional tenant label. Everything that
 * decides anything lives in `@/lib/prometheus-form` and is tested there; this
 * file is the controls.
 */

export interface PrometheusSourceFormValues {
  id: string;
  name: string;
  /** Null exactly when the auth is `none`. */
  secretRef: string | null;
  config: PrometheusConfig;
}

export interface PrometheusSourceFormInitial {
  id?: string;
  name?: string;
  secretRef?: string | null;
  config?: PrometheusConfig;
}

const AUTH_OPTIONS: { value: PrometheusAuth; label: string }[] = [
  { value: "bearer", label: "Bearer token" },
  { value: "basic", label: "User name and password" },
  { value: "none", label: "None (in-cluster endpoint)" },
];

export function PrometheusSourceForm({
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
  initial?: PrometheusSourceFormInitial;
  onSubmit: (values: PrometheusSourceFormValues) => Promise<ApiError | null>;
  onCancel?: () => void;
}) {
  const [id, setId] = React.useState(initial?.id ?? "");
  const [name, setName] = React.useState(initial?.name ?? "");
  const [chosenSecretRef, setSecretRef] = React.useState(initial?.secretRef ?? "");
  const [form, setForm] = React.useState<PrometheusFormState>(() =>
    initial?.config
      ? prometheusFormStateFromConfig(initial.config)
      : emptyPrometheusFormState(),
  );
  const usesRef = needsSecretRef(form.auth);
  const secretRef = usesRef ? effectiveSecretRef(chosenSecretRef, secretRefs) : "";
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [error, setError] = React.useState<ApiError | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [advanced, setAdvanced] = React.useState(false);
  const [advancedText, setAdvancedText] = React.useState("");
  const [advancedError, setAdvancedError] = React.useState<string | null>(null);
  const [menu, setMenu] = React.useState<MetricMenu>(emptyMetricMenu);
  const [query, setQuery] = React.useState("");
  const [discovering, setDiscovering] = React.useState(false);
  const [labelling, setLabelling] = React.useState<string | null>(null);

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
    const outcome = await discoverPrometheusMetrics(discoveryInput());
    setDiscovering(false);
    if (!outcome.ok) {
      setError(outcome.error);
      return;
    }
    setMenu({ ran: true, metrics: outcome.value });
  }

  async function pick(metric: DiscoveredMetric) {
    clear("metrics");
    const selecting = !isSelected(form, metric.name);
    setForm((current) => toggleMetric(current, metric));
    if (!selecting) return;
    // Picking a metric is what asks the endpoint for its labels.
    setLabelling(metric.name);
    const outcome = await discoverPrometheusLabels(discoveryInput(), [metric.name]);
    setLabelling(null);
    if (outcome.ok) setForm((current) => withLabels(current, outcome.value));
    else setError(outcome.error);
  }

  function openAdvanced() {
    setAdvancedText(prometheusConfigText(form));
    setAdvancedError(null);
    setAdvanced(true);
  }

  function editAdvanced(text: string) {
    setAdvancedText(text);
    const parsed = prometheusFormStateFromConfigText(text);
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
    const config = prometheusConfigFromFormState(form);
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

  const matches = searchMenu(menu, query);
  const tenantCandidates = sharedLabels(form);

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {mode === "create" && (
          <Field id="p-id" label="Source id" error={errors.id}>
            <Input
              id="p-id"
              value={id}
              onChange={(e) => {
                setId(e.target.value);
                clear("id");
              }}
              placeholder="prom-prod"
              {...fieldAria("p-id", errors.id)}
            />
          </Field>
        )}
        <Field id="p-name" label="Name" error={errors.name}>
          <Input
            id="p-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              clear("name");
            }}
            placeholder="Production Prometheus"
            {...fieldAria("p-name", errors.name)}
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
          <Label htmlFor="p-config">Endpoint + catalog (JSON)</Label>
          <Textarea
            id="p-config"
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
              id="p-url"
              label="URL"
              error={errors.url}
              hint="The Prometheus HTTP API's base, such as https://prometheus.example.com."
              className="sm:col-span-3"
            >
              <Input
                id="p-url"
                value={form.url}
                onChange={(e) => {
                  setForm({ ...form, url: e.target.value });
                  clear("url");
                }}
                placeholder="https://prometheus.example.com"
                {...fieldAria("p-url", errors.url)}
              />
            </Field>
            <Field id="p-auth" label="Authentication">
              <Select
                id="p-auth"
                className="w-full"
                value={form.auth}
                onValueChange={(auth) =>
                  setForm({ ...form, auth: auth as PrometheusAuth })
                }
                options={AUTH_OPTIONS}
              />
            </Field>
            {usesRef ? (
              <Field
                id="p-secret"
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
                  id="p-secret"
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
                <h3 className="text-sm font-medium">Metrics</h3>
                <p className="text-xs text-muted">
                  The allowlist: only the metrics ticked here may be named by any PromQL.{" "}
                  {form.metrics.length} of at most {MAX_METRICS} selected.
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
                Discover metrics
              </Button>
            </div>
            {errors.metrics && <p className="text-xs text-danger">{errors.metrics}</p>}

            {form.metrics.length > 0 && (
              <ul className="space-y-1">
                {form.metrics.map((metric) => (
                  <li
                    key={metric.name}
                    className="flex flex-wrap items-center gap-2 border border-border bg-surface px-3 py-1.5"
                  >
                    <Checkbox
                      checked
                      onCheckedChange={() => void pick(metric)}
                      label={<span className="font-mono text-xs">{metric.name}</span>}
                    />
                    <Badge>{metric.type}</Badge>
                    <span className="min-w-0 truncate text-xs text-muted">
                      {labelling === metric.name ? (
                        <Loader2 className="inline h-3 w-3 animate-spin" />
                      ) : metric.labels.length > 0 ? (
                        metric.labels.join(", ")
                      ) : (
                        "no labels seen yet"
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
                  placeholder={`Search ${menu.metrics.length} metrics by name, type or help`}
                  aria-label="Search the discovered metrics"
                />
                {matches.length === 0 ? (
                  <p className="border border-dashed border-border px-3 py-4 text-center text-sm text-muted">
                    {menu.metrics.length === 0
                      ? "The endpoint described no metrics."
                      : `No metric matches “${query.trim()}”.`}
                  </p>
                ) : (
                  <ul className="max-h-72 space-y-1 overflow-auto">
                    {matches
                      .filter((m) => !isSelected(form, m.name))
                      .map((metric) => (
                        <li
                          key={metric.name}
                          className="border border-border px-3 py-1.5"
                        >
                          <Checkbox
                            checked={false}
                            onCheckedChange={() => void pick(metric)}
                            label={
                              <span>
                                <span className="font-mono text-xs">{metric.name}</span>{" "}
                                <span className="ml-1 text-xs text-muted">
                                  {metric.type}
                                </span>
                              </span>
                            }
                          />
                          {metric.help && (
                            <p
                              className="mt-0.5 truncate pl-6 text-xs text-muted"
                              title={metric.help}
                            >
                              {metric.help}
                            </p>
                          )}
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            )}
            {!menu.ran && form.metrics.length === 0 && (
              <p className="border border-dashed border-border px-3 py-6 text-center text-sm text-muted">
                Fill in the endpoint, then discover the metrics this source may read.
              </p>
            )}
          </div>

          <div className="grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
            <Field
              id="p-tenant-label"
              label="Tenant label (optional)"
              error={errors["rowFilter.label"]}
              hint={
                tenantCandidates.length > 0
                  ? `Labels every selected metric has: ${tenantCandidates.join(", ")}.`
                  : "Narrows every query to series whose label equals the viewer's claim."
              }
            >
              <Input
                id="p-tenant-label"
                value={form.rowFilterLabel}
                onChange={(e) => {
                  setForm({ ...form, rowFilterLabel: e.target.value });
                  clear("rowFilter.label");
                }}
                placeholder="tenant"
                {...fieldAria("p-tenant-label", errors["rowFilter.label"])}
              />
            </Field>
            <Field id="p-tenant-claim" label="Claim" error={errors["rowFilter.claim"]}>
              <Input
                id="p-tenant-claim"
                value={form.rowFilterClaim}
                onChange={(e) => {
                  setForm({ ...form, rowFilterClaim: e.target.value });
                  clear("rowFilter.claim");
                }}
                placeholder="sub"
                {...fieldAria("p-tenant-claim", errors["rowFilter.claim"])}
              />
            </Field>
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
