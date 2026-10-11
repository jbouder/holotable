"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { apiErrorFromThrown, readApiError } from "@/lib/errors";
import {
  credentialsNoun,
  describeKey,
  emptyDraft,
  inputFromDraft,
  type KeyState,
  type ModelConfigDraft,
  type ModelConfigInput,
} from "@/lib/ai/model-config";
import type { ModelTestResult } from "@/lib/ai/model-test-result";
import type { DiscoveredModel } from "@/lib/ai/model-config";
import { providerKind, selectableKinds } from "@/lib/ai/providers/registry";
import type { ProviderField } from "@/lib/ai/providers/types";

type TestStatus =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "done"; result: ModelTestResult }
  | { kind: "error"; message: string };

/**
 * The fields of one model configuration (#331, #438), shared by the
 * Models page's Add and Edit dialog (#441), with "Test connection": a provider
 * select over the registry's kinds, then the fields the chosen kind draws.
 * Credentials fields are write-only: they start empty whatever is stored,
 * and blank keeps the stored ones. `testBody` wraps the input in what the
 * page's test route expects. `allowStub` lists the recorded model, which the
 * server accepts only outside production or for the end-to-end suite.
 */
export function ModelFields({
  draft,
  onChange,
  storedKey,
  testUrl,
  testBody,
  discover = null,
  disabled,
  allowStub = false,
}: {
  draft: ModelConfigDraft;
  onChange: (next: ModelConfigDraft) => void;
  storedKey: KeyState | undefined;
  /** Null hides "Test connection", when there is nowhere to admit the call. */
  testUrl: string | null;
  testBody: (input: ModelConfigInput) => unknown;
  /**
   * "List models" (#443): where to ask, and the body around the form's
   * input. Null hides it; it shows only for a kind that can list.
   */
  discover?: { url: string; body: (input: ModelConfigInput) => unknown } | null;
  disabled?: boolean;
  allowStub?: boolean;
}) {
  const id = React.useId();
  const [test, setTest] = React.useState<TestStatus>({ kind: "idle" });
  const [listed, setListed] = React.useState<DiscoveredModel[] | null>(null);
  const [listing, setListing] = React.useState<
    { kind: "idle" | "busy" } | { kind: "done" | "error"; message: string }
  >({ kind: "idle" });
  const kind = providerKind(draft.provider);
  const hasKey = storedKey?.state === "set" || storedKey?.state === "unreadable";
  const noun = credentialsNoun(kind);
  const providers = selectableKinds(!allowStub).map((k) => ({
    value: k.kind,
    label: k.label,
  }));

  async function runTest() {
    const built = inputFromDraft(draft);
    if (!built.ok) {
      setTest({ kind: "error", message: built.message });
      return;
    }
    if (!testUrl) return;
    setTest({ kind: "testing" });
    try {
      const res = await fetch(testUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testBody(built.input)),
      });
      if (!res.ok) {
        setTest({ kind: "error", message: (await readApiError(res)).error });
        return;
      }
      setTest({ kind: "done", result: (await res.json()) as ModelTestResult });
    } catch (err) {
      setTest({ kind: "error", message: apiErrorFromThrown(err).error });
    }
  }

  /**
   * Ask the vendor which models these credentials may use. The model field
   * may still be empty, so a placeholder stands in for it; the list fills
   * the field's suggestions, and any id can still be typed.
   */
  async function runList() {
    if (!discover) return;
    const built = inputFromDraft({
      ...draft,
      settings: { ...draft.settings, model: draft.settings.model?.trim() || "*" },
    });
    if (!built.ok) {
      setListing({ kind: "error", message: built.message });
      return;
    }
    setListing({ kind: "busy" });
    try {
      const res = await fetch(discover.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(discover.body(built.input)),
      });
      if (!res.ok) {
        setListing({ kind: "error", message: (await readApiError(res)).error });
        return;
      }
      const result = (await res.json()) as
        | { ok: true; models: DiscoveredModel[] }
        | { ok: false; message: string };
      if (!result.ok) {
        setListing({ kind: "error", message: result.message });
        return;
      }
      setListed(result.models);
      setListing({
        kind: "done",
        message:
          result.models.length === 0
            ? "The provider listed no models; type the model id."
            : `${result.models.length} ${result.models.length === 1 ? "model" : "models"} listed: pick one in the Model field, or type any id.`,
      });
    } catch (err) {
      setListing({ kind: "error", message: apiErrorFromThrown(err).error });
    }
  }

  const change = (next: ModelConfigDraft) => {
    setTest({ kind: "idle" });
    if (next.provider !== draft.provider) {
      setListed(null);
      setListing({ kind: "idle" });
    }
    onChange(next);
  };

  const setField = (field: ProviderField, value: string) =>
    change({ ...draft, [field.in]: { ...draft[field.in], [field.name]: value } });

  const chooseProvider = (provider: string) => {
    // A new kind starts empty, but keeps the model id typed so far.
    const next = emptyDraft(provider);
    if ("model" in next.settings) next.settings.model = draft.settings.model ?? "";
    change(next);
  };

  const credentialsField = kind?.fields.find((f) => f.in === "credentials");

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Label htmlFor={`${id}-provider`}>Provider</Label>
          <Select
            id={`${id}-provider`}
            className="w-full sm:w-80"
            disabled={disabled}
            value={draft.provider}
            options={providers}
            onValueChange={chooseProvider}
          />
          {kind && <p className="mt-1 text-xs text-muted">{kind.description}</p>}
        </div>
        {kind?.fields.map((field) => {
          const fieldId = `${id}-${field.in}-${field.name}`;
          const value =
            (field.in === "settings" ? draft.settings : draft.credentials)[field.name] ??
            "";
          const describedBy =
            field === credentialsField
              ? `${id}-key-state`
              : field.help
                ? `${fieldId}-help`
                : undefined;
          return (
            <div key={fieldId}>
              <Label htmlFor={fieldId}>
                {field.label}
                {field.optional && <span className="text-muted"> (optional)</span>}
              </Label>
              {field.input === "select" ? (
                <Select
                  id={fieldId}
                  className="w-full"
                  disabled={disabled}
                  value={value}
                  options={[...(field.options ?? [])]}
                  onValueChange={(v) => setField(field, v)}
                />
              ) : (
                <Input
                  id={fieldId}
                  type={
                    field.secret ? "password" : field.input === "url" ? "url" : "text"
                  }
                  inputMode={field.input === "url" ? "url" : undefined}
                  autoComplete={field.secret ? "new-password" : "off"}
                  spellCheck={false}
                  disabled={
                    disabled || (field.in === "credentials" && draft.clearCredentials)
                  }
                  maxLength={field.maxLength}
                  placeholder={
                    field.in === "credentials" && hasKey
                      ? `Leave blank to keep the stored ${noun}`
                      : field.placeholder
                  }
                  value={value}
                  onChange={(e) => setField(field, e.target.value)}
                  aria-describedby={describedBy}
                  list={
                    field.in === "settings" && field.name === "model" && listed
                      ? `${id}-listed`
                      : undefined
                  }
                />
              )}
              {field.in === "settings" && field.name === "model" && listed && (
                <datalist id={`${id}-listed`}>
                  {listed.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name ?? m.id}
                    </option>
                  ))}
                </datalist>
              )}
              {field.help && (
                <p id={`${fieldId}-help`} className="mt-1 text-xs text-muted">
                  {field.help}
                </p>
              )}
              {field === credentialsField && (
                <>
                  <p
                    id={`${id}-key-state`}
                    className={
                      storedKey?.state === "unreadable"
                        ? "mt-1 text-xs text-warning"
                        : "mt-1 text-xs text-muted"
                    }
                  >
                    {describeKey(storedKey, noun)} Never shown again after it is saved.
                  </p>
                  {hasKey && (
                    <Checkbox
                      className="mt-2"
                      disabled={disabled}
                      checked={draft.clearCredentials}
                      onCheckedChange={(clearCredentials) =>
                        change({
                          ...draft,
                          clearCredentials,
                          credentials: Object.fromEntries(
                            Object.keys(draft.credentials).map((k) => [k, ""]),
                          ),
                        })
                      }
                      label={`Remove the stored ${noun} (for an endpoint that needs none)`}
                    />
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
      {testUrl && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={disabled || test.kind === "testing"}
            onClick={() => void runTest()}
          >
            {test.kind === "testing" && (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            )}
            Test connection
          </Button>
          {discover && kind?.listsModels && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={disabled || listing.kind === "busy"}
              onClick={() => void runList()}
            >
              {listing.kind === "busy" && (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              )}
              List models
            </Button>
          )}
          <p role="status" className="text-xs">
            {test.kind === "done" && test.result.ok && (
              <span className="fade-in text-success">
                Connected: {test.result.model || draft.settings.model} answered in{" "}
                {test.result.latencyMs} ms.
              </span>
            )}
            {test.kind === "done" && !test.result.ok && (
              <span className="fade-in text-danger">{test.result.message}</span>
            )}
            {test.kind === "error" && (
              <span className="fade-in text-danger">{test.message}</span>
            )}
          </p>
          <p role="status" className="basis-full text-xs">
            {listing.kind === "done" && (
              <span className="fade-in text-muted">{listing.message}</span>
            )}
            {listing.kind === "error" && (
              <span className="fade-in text-danger">{listing.message}</span>
            )}
          </p>
        </div>
      )}
    </div>
  );
}
