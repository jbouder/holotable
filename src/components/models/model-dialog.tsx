"use client";

import * as React from "react";
import { ModelFields } from "@/components/models/model-fields";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import {
  draftFromView,
  emptyDraft,
  inputFromDraft,
  type ModelConfigDraft,
  type ModelConfigInput,
  type ModelView,
} from "@/lib/ai/model-config";
import { apiErrorFromThrown, readApiError } from "@/lib/errors";

/** Where a dialog saves and tests: a workspace's models or the caller's own. */
export interface ModelDialogTarget {
  /** The collection to POST a new model to; a saved one is PUT at `<url>/<id>`. */
  url: string;
  /** The test route, or null when there is nowhere to admit the call. */
  testUrl: (id: string | null) => string | null;
  testBody: (input: ModelConfigInput, id: string | null) => unknown;
  /** "List models" (#443): the discover request for this owner, or null. */
  discoverBody: ((input: ModelConfigInput, id: string | null) => unknown) | null;
}

/**
 * Add or edit one model (#441): its name, a provider from the registry, the
 * fields that provider draws, "Test connection" on the unsaved form, and
 * Save. Credentials follow #331's rules: they start empty whatever is
 * stored, blank keeps them, "Remove" clears them, and a changed host asks
 * for them again (the server says so).
 */
export function ModelDialog({
  open,
  onOpenChange,
  initial,
  defaultName,
  target,
  allowStub,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The model being edited, or null to add one. */
  initial: ModelView | null;
  /** The name a new model starts with. */
  defaultName?: string;
  target: ModelDialogTarget;
  allowStub: boolean;
  onSaved: (saved: ModelView) => void;
}) {
  const id = React.useId();
  const [name, setName] = React.useState(initial?.name ?? defaultName ?? "");
  const [draft, setDraft] = React.useState<ModelConfigDraft>(() =>
    initial ? draftFromView(initial) : emptyDraft(),
  );
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const built = inputFromDraft(draft);
    if (!built.ok) {
      setError(built.message);
      return;
    }
    if (!name.trim()) {
      setError("Name: name the model");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        initial ? `${target.url}/${encodeURIComponent(initial.id)}` : target.url,
        {
          method: initial ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...built.input, name: name.trim() }),
        },
      );
      if (!res.ok) {
        setError((await readApiError(res)).error);
        return;
      }
      onSaved((await res.json()) as ModelView);
    } catch (err) {
      setError(apiErrorFromThrown(err).error);
    } finally {
      setSaving(false);
    }
  }

  const modelId = initial?.id ?? null;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={initial ? `Edit ${initial.name}` : "Add model"}
      className="max-w-2xl"
    >
      <form onSubmit={(e) => void save(e)} className="space-y-5 text-sm">
        <div className="max-w-sm">
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input
            id={`${id}-name`}
            autoComplete="off"
            maxLength={80}
            placeholder="Claude for dashboards"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
          <p className="mt-1 text-xs text-muted">
            What people see when they pick a model.
          </p>
        </div>
        <ModelFields
          draft={draft}
          onChange={(next) => {
            setDraft(next);
            setError(null);
          }}
          storedKey={initial?.key}
          testUrl={target.testUrl(modelId)}
          testBody={(input) => target.testBody(input, modelId)}
          discover={
            target.discoverBody
              ? {
                  url: "/api/models/discover",
                  body: (input) => target.discoverBody?.(input, modelId),
                }
              : null
          }
          allowStub={allowStub}
        />
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border pt-4">
          <p role="status" className="mr-auto text-xs">
            {error && <span className="fade-in text-danger">{error}</span>}
          </p>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" busy={saving}>
            {saving ? "Saving…" : initial ? "Save changes" : "Add model"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
