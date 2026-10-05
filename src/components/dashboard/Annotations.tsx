"use client";

import * as React from "react";
import { Flag, Plus, Trash2 } from "lucide-react";
import { useTimeDisplay } from "@/components/time-display";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { ErrorDisplay } from "@/components/ui/error-display";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Popover } from "@/components/ui/popover";
import { Select } from "@/components/ui/select";
import {
  ANNOTATION_KINDS,
  type Annotation,
  AnnotationInput,
  type AnnotationKind,
  readAnnotations,
} from "@/lib/annotations";
import { type ApiError, apiErrorFromThrown, readApiError } from "@/lib/errors";
import type { TimeRange } from "@/lib/ir";
import { describeIssue } from "@/lib/panel-options";
import { formatInstant, fromLocalInput, toLocalInput } from "@/lib/time-range";

/** How often the open dashboard looks for new markers, such as a deploy from CI. */
const ANNOTATION_REFRESH_MS = 60_000;

/**
 * The annotations a dashboard shows for a window (#68), from the server,
 * which resolves the window and reads only the dashboard's own workspace.
 * Re-read when the window changes, every minute while open, and after a
 * change made here. Undefined while off or before the first answer.
 */
export function useAnnotations(
  dashboardId: string,
  timeRange: TimeRange,
  enabled: boolean,
): { annotations: Annotation[] | undefined; reload: () => void } {
  const [annotations, setAnnotations] = React.useState<Annotation[]>();
  const [nonce, setNonce] = React.useState(0);
  const url = `/api/dashboards/${dashboardId}/annotations?${new URLSearchParams(timeRange)}`;

  // `nonce` forces a re-read after an add or a delete.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the nonce exists to re-run the fetch
  React.useEffect(() => {
    if (!enabled) {
      setAnnotations(undefined);
      return;
    }
    let active = true;
    const load = async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) return;
        const list = readAnnotations(await res.json());
        if (active) setAnnotations(list);
      } catch {
        // Annotations are context; a failed read leaves the last ones drawn.
      }
    };
    void load();
    const id = setInterval(() => void load(), ANNOTATION_REFRESH_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [url, enabled, nonce]);

  const reload = React.useCallback(() => setNonce((n) => n + 1), []);
  return { annotations, reload };
}

/**
 * The header control: show or hide the markers on this view, the ones in the
 * window, and, for an editor, adding and removing them.
 */
export function AnnotationsControl({
  annotations,
  shown,
  onShownChange,
  workspaceId,
  canEdit,
  onChanged,
}: {
  annotations: Annotation[] | undefined;
  shown: boolean;
  onShownChange: (shown: boolean) => void;
  workspaceId: string;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const display = useTimeDisplay();
  const [adding, setAdding] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);
  const count = annotations?.length ?? 0;

  async function remove(id: string) {
    setError(null);
    try {
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/annotations/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      if (!res.ok) setError(await readApiError(res));
      onChanged();
    } catch (err) {
      setError(apiErrorFromThrown(err));
    }
  }

  return (
    <>
      <Popover
        label={`Annotations: ${count} in this window`}
        className="h-8 w-8"
        panelClassName="w-80 max-w-[calc(100vw-2rem)]"
        align="end"
        trigger={<Flag className="h-4 w-4" aria-hidden />}
      >
        <div className="space-y-3">
          <Checkbox
            checked={shown}
            label="Show annotations on charts"
            onCheckedChange={onShownChange}
          />
          {count === 0 ? (
            <p className="text-muted">No annotations in this window.</p>
          ) : (
            <ul className="max-h-60 space-y-2 overflow-auto">
              {annotations?.map((a) => (
                <li key={a.id} className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{a.title}</p>
                    <p className="text-muted">
                      {a.kind} · {formatInstant(new Date(a.at), display)}
                      {a.endedAt !== undefined &&
                        ` → ${formatInstant(new Date(a.endedAt), display)}`}
                      {a.source !== "manual" && ` · ${a.source}`}
                    </p>
                  </div>
                  {canEdit && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0"
                      aria-label={`Delete annotation ${a.title}`}
                      onClick={() => void remove(a.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {error && <ErrorDisplay error={error} />}
          {canEdit && (
            <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Add annotation
            </Button>
          )}
        </div>
      </Popover>
      {canEdit && (
        <AddAnnotationDialog
          open={adding}
          onOpenChange={setAdding}
          workspaceId={workspaceId}
          onAdded={() => {
            setAdding(false);
            onChanged();
          }}
        />
      )}
    </>
  );
}

function AddAnnotationDialog({
  open,
  onOpenChange,
  workspaceId,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  onAdded: () => void;
}) {
  const display = useTimeDisplay();
  const [kind, setKind] = React.useState<AnnotationKind>("deploy");
  const [title, setTitle] = React.useState("");
  const [at, setAt] = React.useState(() => toLocalInput(new Date(), display));
  const [endedAt, setEndedAt] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [tags, setTags] = React.useState("");
  const [problem, setProblem] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function submit() {
    const start = fromLocalInput(at, display);
    const end = endedAt.trim() ? fromLocalInput(endedAt, display) : undefined;
    if (!start || end === null) {
      setProblem("Enter a valid date and time.");
      return;
    }
    const parsed = AnnotationInput.safeParse({
      at: start.toISOString(),
      ...(end ? { endedAt: end.toISOString() } : {}),
      kind,
      title,
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(tags.trim()
        ? {
            tags: tags
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean),
          }
        : {}),
    });
    if (!parsed.success) {
      setProblem(describeIssue(parsed.error.issues[0]));
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/annotations`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(parsed.data),
        },
      );
      if (!res.ok) {
        setProblem((await readApiError(res)).error);
        return;
      }
      setTitle("");
      setDescription("");
      setEndedAt("");
      onAdded();
    } catch (err) {
      setProblem(apiErrorFromThrown(err).error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add annotation"
      className="max-w-lg"
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor="annotation-kind">Kind</Label>
            <Select
              id="annotation-kind"
              className="w-full min-w-0"
              value={kind}
              onValueChange={(v) => setKind(v as AnnotationKind)}
              options={ANNOTATION_KINDS.map((k) => ({ value: k, label: k }))}
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="annotation-title">Title</Label>
            <Input
              id="annotation-title"
              maxLength={200}
              placeholder="Deployed api v2.4.1"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="annotation-at">At</Label>
            <Input
              id="annotation-at"
              type="datetime-local"
              step={1}
              value={at}
              onChange={(e) => setAt(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="annotation-end">Until (optional, for a range)</Label>
            <Input
              id="annotation-end"
              type="datetime-local"
              step={1}
              value={endedAt}
              onChange={(e) => setEndedAt(e.target.value)}
            />
          </div>
        </div>
        <div>
          <Label htmlFor="annotation-description">Description</Label>
          <Textarea
            id="annotation-description"
            rows={2}
            maxLength={2_000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="annotation-tags">Tags (comma-separated)</Label>
          <Input
            id="annotation-tags"
            placeholder="api, prod"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
          />
        </div>
        {problem && <p className="text-xs text-danger">{problem}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Adding…" : "Add"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
