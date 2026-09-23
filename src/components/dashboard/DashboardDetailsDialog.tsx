"use client";

import * as React from "react";
import { Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { ErrorDisplay } from "@/components/ui/error-display";
import { type ApiError, readApiError } from "@/lib/errors";
import {
  DESCRIPTION_MAX,
  MAX_TAGS,
  normalizeTag,
  normalizeTags,
  parseTagInput,
} from "@/lib/dashboard-metadata";

export interface DashboardDetails {
  title: string;
  description: string | null;
  tags: string[];
}

/**
 * Edit a dashboard's name, description and tags without opening the editor.
 *
 * The three fields go out as one `PATCH`, and the server decides what each one
 * costs: description and tags are columns and are written in place, while the
 * title lives in the spec and so appends a version. The dialog says so rather
 * than hiding it — someone renaming a dashboard should know a version row
 * appears, because that is what keeps the name in the exported spec.
 */
export function DashboardDetailsDialog({
  dashboardId,
  initial,
  suggestions = [],
  allowRename = true,
  open,
  onOpenChange,
  onSaved,
}: {
  dashboardId: string;
  initial: DashboardDetails;
  /** Tags already in use in this workspace, offered rather than required. */
  suggestions?: string[];
  /** False in the editor, where the title is a spec field on the page itself. */
  allowRename?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (next: DashboardDetails) => void;
}) {
  const [title, setTitle] = React.useState(initial.title);
  const [description, setDescription] = React.useState(initial.description ?? "");
  const [tags, setTags] = React.useState(initial.tags);
  const [draftTag, setDraftTag] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);

  // Reopening shows what is stored, not what was typed and abandoned last time.
  React.useEffect(() => {
    if (!open) return;
    setTitle(initial.title);
    setDescription(initial.description ?? "");
    setTags(initial.tags);
    setDraftTag("");
    setError(null);
  }, [open, initial]);

  function addTags(text: string) {
    const next = normalizeTags([...tags, ...parseTagInput(text)]);
    setTags(next);
    setDraftTag("");
  }

  async function save() {
    setSaving(true);
    setError(null);
    // The tag being typed when Save is pressed is a tag the person meant to
    // add; dropping it because they did not press Enter is the classic way a
    // tag input loses work.
    const nextTags = normalizeTags([...tags, ...parseTagInput(draftTag)]);
    const body: Record<string, unknown> = {
      description: description.trim() || null,
      tags: nextTags,
    };
    if (allowRename) body.title = title.trim();

    const res = await fetch(`/api/dashboards/${dashboardId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      setError(await readApiError(res));
      setSaving(false);
      return;
    }
    setSaving(false);
    onSaved?.({
      title: allowRename ? title.trim() : initial.title,
      description: description.trim() || null,
      tags: nextTags,
    });
    onOpenChange(false);
  }

  const unusedSuggestions = suggestions.filter((tag) => !tags.includes(tag)).slice(0, 8);
  const renamed = allowRename && title.trim() !== initial.title;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Dashboard details"
      className="max-w-xl"
    >
      <div className="flex flex-col gap-4">
        {allowRename && (
          <div>
            <Label htmlFor="dashboard-title">Name</Label>
            <Input
              id="dashboard-title"
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
            />
            {renamed && (
              <p className="mt-1 text-xs text-muted">
                Renaming saves a new version — the name lives in the spec, so the two can
                never disagree.
              </p>
            )}
          </div>
        )}

        <div>
          <Label htmlFor="dashboard-description">Description</Label>
          <Textarea
            id="dashboard-description"
            rows={3}
            value={description}
            maxLength={DESCRIPTION_MAX}
            placeholder="What this dashboard is for, and who should look at it."
            onChange={(e) => setDescription(e.target.value)}
          />
          <p className="mt-1 text-xs text-muted">
            Shown on the list and above the panels. Not part of the spec, so editing it
            does not save a version.
          </p>
        </div>

        <div>
          <Label htmlFor="dashboard-tag">Tags</Label>
          {tags.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => setTags(tags.filter((t) => t !== tag))}
                  className="inline-flex cursor-pointer items-center gap-1 border border-border bg-surface-2 px-2.5 py-0.5 text-xs text-foreground transition-colors hover:border-danger/50 hover:text-danger"
                >
                  {tag}
                  <X className="h-3 w-3" aria-hidden />
                  <span className="sr-only">Remove tag {tag}</span>
                </button>
              ))}
            </div>
          )}
          <Input
            id="dashboard-tag"
            value={draftTag}
            placeholder={
              tags.length >= MAX_TAGS
                ? `${MAX_TAGS} tags is the limit`
                : "prod, latency — comma or Enter to add"
            }
            disabled={tags.length >= MAX_TAGS}
            onChange={(e) => {
              // A typed comma is how people separate tags, so it commits
              // rather than waiting for Enter.
              if (e.target.value.includes(",")) addTags(e.target.value);
              else setDraftTag(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && normalizeTag(draftTag)) {
                e.preventDefault();
                addTags(draftTag);
              }
            }}
          />
          {unusedSuggestions.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted">In use here:</span>
              {unusedSuggestions.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => addTags(tag)}
                  disabled={tags.length >= MAX_TAGS}
                  className="cursor-pointer border border-border px-2.5 py-0.5 text-xs text-muted transition-colors hover:border-primary/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {tag}
                </button>
              ))}
            </div>
          )}
        </div>

        {error && <ErrorDisplay error={error} onRetry={save} retryLabel="Try again" />}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || (allowRename && !title.trim())}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Save details
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
