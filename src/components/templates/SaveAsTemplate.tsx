"use client";

import * as React from "react";
import { BookmarkPlus, Check, Loader2 } from "lucide-react";
import type { ApiError } from "@/lib/errors";
import type { Dashboard, Panel } from "@/lib/ir";
import {
  type TemplateBody,
  dashboardTemplateBody,
  panelTemplateBody,
  saveTemplate,
  summarizeTemplate,
  templateSourceIds,
} from "@/lib/templates";
import { Button, ButtonLabel } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { ErrorDisplay } from "@/components/ui/error-display";

/**
 * Keep a panel or a dashboard as a reusable template.
 *
 * `subject` is the live panel or dashboard, and the body is built from it when
 * the dialog opens rather than on every render — a panel mid-edit can fail the
 * IR (an empty title is a moment's typing), and that has to surface as a
 * refusal to save, not as a render that throws. Passing a plain value rather
 * than a builder function is also what lets a *server* component mount this.
 *
 * Nothing is stripped on the way through: a template body is the IR, and the
 * IR already carries no connection detail or credential, so there is no second
 * allowlist to keep in step.
 *
 * The save is not the panel's save. A template is a copy taken at this moment;
 * editing the panel afterwards does not change the template, and applying the
 * template later does not touch the panel it came from.
 */
export function SaveAsTemplate({
  workspaceId,
  subject,
  defaultName,
  disabled,
  label = "Save as template",
  collapse = false,
  size = "sm",
  variant = "secondary",
}: {
  workspaceId: string;
  /** The live panel or dashboard; read when the dialog opens. */
  subject: { kind: "panel"; panel: Panel } | { kind: "dashboard"; dashboard: Dashboard };
  defaultName: string;
  disabled?: boolean;
  label?: string;
  /** Collapse the trigger to its icon below `sm` (see `Button`'s `collapse`). */
  collapse?: boolean;
  size?: "sm" | "md";
  variant?: "secondary" | "ghost";
}) {
  const [open, setOpen] = React.useState(false);
  const [snapshot, setSnapshot] = React.useState<TemplateBody | null>(null);
  const [name, setName] = React.useState(defaultName);
  const [description, setDescription] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState<string | null>(null);
  const [error, setError] = React.useState<ApiError | null>(null);

  function openDialog() {
    setName(defaultName);
    setDescription("");
    setSaved(null);
    // Frozen when the dialog opens: the dialog is modal, so what the author
    // sees named and counted here is exactly what the Save writes.
    try {
      setSnapshot(
        subject.kind === "panel"
          ? panelTemplateBody(subject.panel)
          : dashboardTemplateBody(subject.dashboard),
      );
      setError(null);
    } catch (err) {
      setSnapshot(null);
      setError({
        error: `This ${subject.kind} is not a valid spec yet: ${
          err instanceof Error ? err.message.slice(0, 200) : "validation failed"
        }`,
        kind: "validation",
      });
    }
    setOpen(true);
  }

  async function submit() {
    if (!snapshot || !name.trim()) return;
    setSaving(true);
    setError(null);
    const outcome = await saveTemplate({
      workspaceId,
      name: name.trim(),
      description: description.trim() || undefined,
      body: snapshot,
    });
    setSaving(false);
    if (!outcome.ok) {
      setError(outcome.error);
      return;
    }
    setSaved(outcome.template.name);
    setOpen(false);
  }

  const kindWord = subject.kind;
  const sourceCount = snapshot ? templateSourceIds(snapshot).length : 0;

  return (
    <>
      <Button
        variant={variant}
        size={size}
        collapse={collapse}
        title={collapse ? label : undefined}
        onClick={openDialog}
        disabled={disabled}
      >
        {saved ? <Check className="h-4 w-4" /> : <BookmarkPlus className="h-4 w-4" />}
        {collapse ? (
          <ButtonLabel>{saved ? "Saved as template" : label}</ButtonLabel>
        ) : saved ? (
          "Saved as template"
        ) : (
          label
        )}
      </Button>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={`Save this ${kindWord} as a template`}
        className="max-w-lg"
      >
        <div className="space-y-4">
          <p className="text-sm text-muted">
            The spec is copied as it stands now. Applying it later re-points it at a
            source you pick and re-checks the SQL against that source&rsquo;s catalog —
            nothing is linked back to this {kindWord}.
          </p>

          <div>
            <Label htmlFor="template-name">Name</Label>
            <Input
              id="template-name"
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div>
            <Label htmlFor="template-description">Description (optional)</Label>
            <Textarea
              id="template-description"
              rows={2}
              maxLength={500}
              placeholder="What this is for, and what to point it at"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {snapshot && (
            <p className="text-xs text-muted">
              {summarizeTemplate(snapshot)} · {sourceCount}{" "}
              {sourceCount === 1 ? "source" : "sources"} referenced · saved to workspace{" "}
              <code>{workspaceId}</code>
            </p>
          )}

          {error && <ErrorDisplay error={error} />}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button
              onClick={() => void submit()}
              disabled={saving || !snapshot || !name.trim()}
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <BookmarkPlus className="h-4 w-4" />
              )}
              Save template
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
