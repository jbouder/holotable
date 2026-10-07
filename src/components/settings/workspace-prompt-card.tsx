"use client";

import * as React from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { CopyButton } from "@/components/settings/copy-button";
import { useTimeDisplay } from "@/components/time-display";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { apiErrorFromThrown, readApiError } from "@/lib/errors";
import { formatInstant } from "@/lib/time-range";
import {
  draftFromPrompt,
  PROMPT_LIMITS,
  promptFromDraft,
  type WorkspacePromptDraft,
  type WorkspacePromptView,
} from "@/lib/workspace-prompt";

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

/**
 * One workspace's prompt customization (#66): the glossary, metric
 * definitions and example panels, editable by a source-admin and readable by
 * anyone who generates there, and the composed system prompt for any of the
 * workspace's sources. The routes re-check both; `canEdit` only decides
 * whether the form is drawn.
 */
export function WorkspacePromptCard({
  initial,
  canEdit,
  sources,
}: {
  initial: WorkspacePromptView;
  canEdit: boolean;
  sources: Array<{ id: string; name: string }>;
}) {
  const display = useTimeDisplay();
  const id = initial.workspaceId;
  const base = `/api/workspaces/${encodeURIComponent(id)}/prompt`;
  const fieldId = React.useId();
  const [view, setView] = React.useState(initial);
  const [draft, setDraft] = React.useState<WorkspacePromptDraft>(() =>
    draftFromPrompt(initial.prompt),
  );
  const [status, setStatus] = React.useState<Status>({ kind: "idle" });

  const update = (patch: Partial<WorkspacePromptDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setStatus({ kind: "idle" });
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const body = promptFromDraft(draft);
    if (!body.ok) {
      setStatus({ kind: "error", message: body.message });
      return;
    }
    setStatus({ kind: "saving" });
    try {
      const res = await fetch(base, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body.prompt),
      });
      if (!res.ok) {
        setStatus({ kind: "error", message: (await readApiError(res)).error });
        return;
      }
      const next = (await res.json()) as WorkspacePromptView;
      setView(next);
      setDraft(draftFromPrompt(next.prompt));
      setStatus({ kind: "saved" });
    } catch (err) {
      setStatus({ kind: "error", message: apiErrorFromThrown(err).error });
    }
  }

  const readOnly = !canEdit;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-mono">{id}</CardTitle>
        <p className="text-xs text-muted">
          {view.updatedAt
            ? `Updated ${formatInstant(new Date(view.updatedAt), display)}`
            : "Not customized yet"}
        </p>
      </CardHeader>
      <form onSubmit={(e) => void save(e)}>
        <CardContent className="space-y-6 text-sm">
          <div>
            <Label htmlFor={`${fieldId}-glossary`}>Glossary</Label>
            <Textarea
              id={`${fieldId}-glossary`}
              rows={4}
              readOnly={readOnly}
              maxLength={PROMPT_LIMITS.glossary}
              placeholder={
                readOnly
                  ? "No glossary."
                  : 'e.g. "Latency" means p95 of http_requests.duration_ms, measured server-side.'
              }
              value={draft.glossary}
              onChange={(e) => update({ glossary: e.target.value })}
            />
            <p className="mt-1 text-xs text-muted">
              {draft.glossary.length} / {PROMPT_LIMITS.glossary} characters
            </p>
          </div>

          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-medium text-muted">
              Metric definitions
            </legend>
            {draft.metricDefinitions.length === 0 && (
              <p className="text-xs text-muted">No metric definitions.</p>
            )}
            {draft.metricDefinitions.map((m, i) => (
              <div
                // Rows have no identity of their own; their position is it.
                // biome-ignore lint/suspicious/noArrayIndexKey: see above
                key={i}
                className="grid grid-cols-1 gap-2 sm:grid-cols-[12rem_1fr_auto]"
              >
                <Input
                  aria-label={`Metric ${i + 1} name`}
                  readOnly={readOnly}
                  maxLength={PROMPT_LIMITS.metricName}
                  placeholder="error rate"
                  value={m.name}
                  onChange={(e) =>
                    update({
                      metricDefinitions: draft.metricDefinitions.map((x, j) =>
                        j === i ? { ...x, name: e.target.value } : x,
                      ),
                    })
                  }
                />
                <Input
                  aria-label={`Metric ${i + 1} definition`}
                  readOnly={readOnly}
                  maxLength={PROMPT_LIMITS.metricDefinition}
                  placeholder="share of http_requests with status >= 500"
                  value={m.definition}
                  onChange={(e) =>
                    update({
                      metricDefinitions: draft.metricDefinitions.map((x, j) =>
                        j === i ? { ...x, definition: e.target.value } : x,
                      ),
                    })
                  }
                />
                {canEdit && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove metric ${i + 1}`}
                    onClick={() =>
                      update({
                        metricDefinitions: draft.metricDefinitions.filter(
                          (_, j) => j !== i,
                        ),
                      })
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
            {canEdit &&
              draft.metricDefinitions.length < PROMPT_LIMITS.metricDefinitions && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    update({
                      metricDefinitions: [
                        ...draft.metricDefinitions,
                        { name: "", definition: "" },
                      ],
                    })
                  }
                >
                  <Plus className="h-4 w-4" />
                  Add metric
                </Button>
              )}
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="mb-1 text-sm font-medium text-muted">
              Example panels
            </legend>
            <p className="text-xs text-muted">
              A request and the panel that answers it, as panel JSON from a dashboard
              export. Each panel&apos;s SQL is checked against its source when you save,
              and the model sees an example only when generating against that source.
            </p>
            {draft.examples.length === 0 && (
              <p className="text-xs text-muted">No example panels.</p>
            )}
            {draft.examples.map((e, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: as for metrics
                key={i}
                className="space-y-2 border border-border p-3"
              >
                <div className="flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <Label htmlFor={`${fieldId}-example-${i}-prompt`}>
                      Example {i + 1} request
                    </Label>
                    <Input
                      id={`${fieldId}-example-${i}-prompt`}
                      readOnly={readOnly}
                      maxLength={PROMPT_LIMITS.examplePrompt}
                      placeholder="p95 latency by route"
                      value={e.prompt}
                      onChange={(ev) =>
                        update({
                          examples: draft.examples.map((x, j) =>
                            j === i ? { ...x, prompt: ev.target.value } : x,
                          ),
                        })
                      }
                    />
                  </div>
                  {canEdit && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove example ${i + 1}`}
                      onClick={() =>
                        update({ examples: draft.examples.filter((_, j) => j !== i) })
                      }
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                <div>
                  <Label htmlFor={`${fieldId}-example-${i}-panel`}>
                    Example {i + 1} panel (JSON)
                  </Label>
                  <Textarea
                    id={`${fieldId}-example-${i}-panel`}
                    rows={8}
                    spellCheck={false}
                    readOnly={readOnly}
                    className="font-mono text-xs"
                    value={e.panelJson}
                    onChange={(ev) =>
                      update({
                        examples: draft.examples.map((x, j) =>
                          j === i ? { ...x, panelJson: ev.target.value } : x,
                        ),
                      })
                    }
                  />
                </div>
              </div>
            ))}
            {canEdit && draft.examples.length < PROMPT_LIMITS.examples && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() =>
                  update({ examples: [...draft.examples, { prompt: "", panelJson: "" }] })
                }
              >
                <Plus className="h-4 w-4" />
                Add example
              </Button>
            )}
          </fieldset>
        </CardContent>

        {canEdit && (
          <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3">
            <Button type="submit" disabled={status.kind === "saving"}>
              {status.kind === "saving" && <Loader2 className="h-4 w-4 animate-spin" />}
              Save context
            </Button>
            <p role="status" className="text-xs">
              {status.kind === "saved" && (
                <span className="fade-in text-success">
                  Saved. The next generation in this workspace uses it.
                </span>
              )}
              {status.kind === "error" && (
                <span className="fade-in text-danger">{status.message}</span>
              )}
            </p>
          </div>
        )}
      </form>

      <ComposedPrompt workspaceBase={base} sources={sources} />
    </Card>
  );
}

/** The system prompt a generation against one of the workspace's sources is given. */
function ComposedPrompt({
  workspaceBase,
  sources,
}: {
  workspaceBase: string;
  sources: Array<{ id: string; name: string }>;
}) {
  const fieldId = React.useId();
  const [sourceId, setSourceId] = React.useState(sources[0]?.id ?? "");
  const [system, setSystem] = React.useState<string | null>(null);
  const [state, setState] = React.useState<
    { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string }
  >({ kind: "idle" });

  async function show() {
    setState({ kind: "loading" });
    try {
      const res = await fetch(
        `${workspaceBase}/preview?sourceId=${encodeURIComponent(sourceId)}`,
      );
      if (!res.ok) {
        setState({ kind: "error", message: (await readApiError(res)).error });
        return;
      }
      setSystem(((await res.json()) as { system: string }).system);
      setState({ kind: "idle" });
    } catch (err) {
      setState({ kind: "error", message: apiErrorFromThrown(err).error });
    }
  }

  if (sources.length === 0) {
    return (
      <p className="border-t border-border px-4 py-3 text-xs text-muted">
        Add a data source to this workspace to see the prompt the model is given.
      </p>
    );
  }

  return (
    <div className="space-y-3 border-t border-border px-4 py-3 text-sm">
      <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_auto]">
        <div>
          <Label htmlFor={`${fieldId}-source`}>Composed prompt for source</Label>
          <Select
            id={`${fieldId}-source`}
            value={sourceId}
            onValueChange={(v) => {
              setSourceId(v);
              setSystem(null);
            }}
            options={sources.map((s) => ({ value: s.id, label: s.name }))}
          />
        </div>
        <Button
          type="button"
          variant="secondary"
          disabled={state.kind === "loading"}
          onClick={() => void show()}
        >
          {state.kind === "loading" && <Loader2 className="h-4 w-4 animate-spin" />}
          Show prompt
        </Button>
      </div>
      {state.kind === "error" && (
        <p role="alert" className="text-xs text-danger">
          {state.message}
        </p>
      )}
      {system !== null && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted">
              What the model is given before the request, as of your last save. The marker
              tokens are new on every generation.
            </p>
            <CopyButton value={system} label="Copy prompt" />
          </div>
          <pre className="max-h-96 overflow-auto border border-border bg-surface-2 p-3 font-mono text-xs whitespace-pre-wrap">
            {system}
          </pre>
        </div>
      )}
    </div>
  );
}
