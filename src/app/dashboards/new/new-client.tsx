"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { experimental_useObject as useObject } from "@ai-sdk/react";
import {
  LayoutTemplate,
  Loader2,
  RefreshCw,
  SendHorizontal,
  Save,
  RotateCcw,
  Undo2,
} from "lucide-react";
import { Dashboard, safeParseDashboard } from "@/lib/ir";
import {
  activeSpec,
  appendTurn,
  EMPTY_HISTORY,
  normalizeTurn,
  replaceTurn,
  restoreTurn,
  type TurnHistory,
} from "@/lib/dashboard-turns";
import { PromptHistoryMenu, usePromptHistory } from "@/components/prompt-history";
import { PROMPT_MAX_LENGTH } from "@/lib/prompt-history";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PreviewDashboard } from "@/components/dashboard/PreviewDashboard";
import { GeneratingPanels } from "@/components/dashboard/GeneratingPanels";
import { ErrorDisplay } from "@/components/ui/error-display";
import { type ApiError, apiErrorFromThrown, readApiError } from "@/lib/errors";
import type { CatalogHealth } from "@/lib/catalog/health";
import {
  CatalogHealthNotice,
  useCatalogRefresh,
} from "@/components/sources/catalog-health";
import { type Template, templateSpec } from "@/lib/templates";
import { TemplatePicker } from "@/components/templates/TemplatePicker";
import { NoSources } from "@/components/onboarding/no-sources";

interface SourceOption {
  id: string;
  name: string;
  workspaceId: string;
  /** Server-decided; the same judgement `/api/generate` refuses on. */
  catalog: CatalogHealth;
  /** Whether this caller may refresh it, i.e. holds `source:manage` here. */
  canRefresh: boolean;
  /**
   * One-click starters built from this source's catalog by `buildStarters`.
   * Per source, so switching the picker switches the chips.
   */
  starters: string[];
}

export function NewDashboardClient({
  sources,
  model,
  canManageSources,
}: {
  sources: SourceOption[];
  model: string;
  /**
   * Whether this caller holds `source:manage` anywhere, which decides whether
   * the no-source empty state offers to add one or names who can.
   */
  canManageSources: boolean;
}) {
  const router = useRouter();
  const [activeTab, setActiveTab] = React.useState<"chat" | "preview">("chat");
  const [sourceId, setSourceId] = React.useState<string | null>(sources[0]?.id ?? null);
  const [prompt, setPrompt] = React.useState("");
  const [history, setHistory] = React.useState<TurnHistory>(EMPTY_HISTORY);
  const [saveError, setSaveError] = React.useState<ApiError | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [picking, setPicking] = React.useState(false);
  // Catalog state for the picker, corrected in place by a Refresh from here.
  const catalog = useCatalogRefresh(
    Object.fromEntries(sources.map((s) => [s.id, s.catalog])),
  );
  const source = sources.find((s) => s.id === sourceId);
  // Chips for the selected source. Server-built from its catalog, so they
  // change with the picker and never describe a table this source cannot read.
  const starters = source?.starters ?? [];

  // Recent prompts for this workspace, offered back on the box (#83). Per
  // workspace because a prompt names that workspace's tables; the list lives
  // in `localStorage` and is never sent anywhere — the durable, redacted record
  // of what was asked is the generation log (#23).
  const prompts = usePromptHistory(source?.workspaceId, "dashboard");

  // Feedback for a regenerate of the turn being previewed. Cleared whenever
  // the turn under review changes, so it cannot be carried onto another one.
  const [feedback, setFeedback] = React.useState("");

  /**
   * The run in flight: what was asked, and whether it is adding a turn or
   * replacing the one being previewed. Held in a ref so the finish callback
   * labels the turn with what was actually asked rather than whatever is in
   * the box by the time the stream lands.
   */
  const running = React.useRef<{ prompt: string; replacing: boolean }>({
    prompt: "",
    replacing: false,
  });

  const finalSpec = activeSpec(history);
  const refining = history.turns.length > 0;

  const { object, submit, isLoading, error, stop } = useObject({
    api: "/api/generate",
    schema: Dashboard,
    onFinish({ object }) {
      if (!object) return;
      const turn = normalizeTurn(running.current.prompt, object, model);
      setHistory((h) =>
        running.current.replacing ? replaceTurn(h, turn) : appendTurn(h, turn),
      );
      setFeedback("");
      // Clear the box only once the turn has landed, so a failed run keeps the
      // prompt for Try again — and only if the author has not started typing
      // the next follow-up into it while this one streamed.
      setPrompt((p) => (p === running.current.prompt ? "" : p));
      setActiveTab("preview");
    },
  });

  /**
   * One model call. `base` is the spec the run starts from — the previewed
   * dashboard for a follow-up, and for a regenerate the spec the turn being
   * replaced was itself generated from, so pressing Regenerate twice cannot
   * compound the model's own output. (Same rule as the panel editor's
   * regenerate, #111.)
   */
  function runGeneration(input: {
    instruction: string;
    base: Dashboard | null;
    replacing: boolean;
  }) {
    if (!sourceId) return;
    setSaveError(null);
    running.current = { prompt: input.instruction, replacing: input.replacing };
    submit(
      input.base
        ? {
            mode: "dashboard-refine",
            sourceId,
            prompt: input.instruction,
            current: input.base,
          }
        : { mode: "dashboard", sourceId, prompt: input.instruction },
    );
  }

  function generate() {
    if (!sourceId || !prompt.trim() || isLoading) return;
    prompts.remember(prompt);
    // A follow-up sends the previewed spec back as context and gets the whole
    // dashboard again; one model call either way. Nothing is persisted until
    // the author saves.
    runGeneration({ instruction: prompt, base: finalSpec, replacing: false });
  }

  /**
   * Ask again for the turn being previewed, with a note about what was wrong.
   *
   * One model call, carrying the turn's own prompt, the spec it was generated
   * from, and the feedback. It replaces that turn rather than adding one: the
   * author is not taking another step, they are asking for a different answer
   * to the step they are looking at.
   */
  function regenerate() {
    const turn = history.turns[history.index];
    if (!turn || isLoading) return;
    const note = feedback.trim();
    const instruction = note
      ? `${turn.prompt}\n\nAdditional feedback: ${note}`.slice(0, PROMPT_MAX_LENGTH)
      : turn.prompt;
    runGeneration({
      instruction,
      base: history.turns[history.index - 1]?.spec ?? null,
      replacing: true,
    });
  }

  /**
   * A template lands as turn one, so it can be refined with follow-ups exactly
   * like a generated dashboard and saved through the same Save. Appended
   * directly rather than through `normalizeTurn`, which re-flows panels two-up:
   * a dashboard template's arrangement is most of what made it worth keeping.
   */
  function applyTemplate(input: { template: Template; sourceId: string }) {
    const spec = templateSpec(input.template.body, {
      title: input.template.name,
      sourceId: input.sourceId,
    });
    setHistory((h) =>
      appendTurn(h, { prompt: `From template "${input.template.name}"`, spec }),
    );
    setSourceId(input.sourceId);
    setSaveError(null);
    setPicking(false);
    setActiveTab("preview");
  }

  function startOver() {
    setHistory(EMPTY_HISTORY);
    setSaveError(null);
    setPrompt("");
    setFeedback("");
    setActiveTab("chat");
  }

  /** Preview an earlier turn. The feedback box belongs to the turn it was typed on. */
  function restore(index: number) {
    setHistory((h) => restoreTurn(h, index));
    setFeedback("");
  }

  async function save() {
    if (!finalSpec) return;
    setSaving(true);
    setSaveError(null);
    const parsed = safeParseDashboard(finalSpec);
    if (!parsed.success) {
      setSaveError({
        error: `The generated spec is invalid: ${parsed.error.issues[0]?.message ?? "validation failed"}`,
        kind: "validation",
      });
      setSaving(false);
      return;
    }
    const res = await fetch("/api/dashboards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: parsed.data }),
    });
    setSaving(false);
    if (!res.ok) {
      setSaveError(await readApiError(res));
      return;
    }
    const body = await res.json();
    router.push(`/dashboards/${body.dashboard.id}`);
  }

  if (sources.length === 0) {
    return (
      <div className="mx-auto max-w-2xl">
        <NoSources canManageSources={canManageSources} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold">New dashboard</h1>
            {model && <Badge title="Generation model">{model}</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted">
            Describe the dashboard you want in plain English. The model generates a
            validated spec; refine it with follow-ups, then preview and save it as live
            panels.
          </p>
        </div>

        <div
          className="flex w-fit border border-border bg-surface p-1"
          role="tablist"
          aria-label="Dashboard workspace"
        >
          {(["chat", "preview"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              aria-controls={`new-dashboard-${tab}-panel`}
              id={`new-dashboard-${tab}-tab`}
              onClick={() => setActiveTab(tab)}
              className={`px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
                activeTab === tab
                  ? "bg-surface-2 text-foreground"
                  : "text-muted hover:text-foreground"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>

      {activeTab === "chat" ? (
        <div
          role="tabpanel"
          id="new-dashboard-chat-panel"
          aria-labelledby="new-dashboard-chat-tab"
          className="space-y-4"
        >
          <Card>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-end gap-4">
                <div>
                  <Label htmlFor="source">Data source</Label>
                  <Select
                    id="source"
                    value={sourceId}
                    onValueChange={setSourceId}
                    disabled={refining}
                    options={sources.map((s) => ({
                      value: s.id,
                      label: `${s.name} (${s.workspaceId})`,
                    }))}
                  />
                </div>
                {!refining && (
                  <Button
                    variant="secondary"
                    className="mb-0.5"
                    onClick={() => setPicking(true)}
                    disabled={isLoading}
                  >
                    <LayoutTemplate className="h-4 w-4" /> Start from a template
                  </Button>
                )}
                {refining && (
                  <p className="pb-3 text-xs text-muted">
                    Locked while refining — start over to build from another source.
                  </p>
                )}
              </div>
              {source && (
                <CatalogHealthNotice
                  source={source}
                  health={catalog.health[source.id]}
                  canRefresh={source.canRefresh}
                  busy={catalog.busy === source.id}
                  error={catalog.error[source.id] || null}
                  onRefresh={() => void catalog.refresh(source.id)}
                />
              )}
              <div>
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="prompt">
                    {refining
                      ? "Refine it — each follow-up is one more turn"
                      : starters.length > 0
                        ? "Describe the dashboard or try one below"
                        : "Describe the dashboard"}
                  </Label>
                  <PromptHistoryMenu
                    history={prompts}
                    disabled={isLoading}
                    onPick={setPrompt}
                  />
                </div>
                {!refining && starters.length > 0 && (
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    {starters.map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        disabled={isLoading}
                        onClick={() => setPrompt(preset)}
                        className="border border-border bg-surface px-3 py-1 text-xs text-muted transition-colors hover:border-primary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {preset}
                      </button>
                    ))}
                  </div>
                )}
                <div className="relative">
                  <Textarea
                    id="prompt"
                    rows={3}
                    className="pr-14"
                    placeholder={
                      refining
                        ? "e.g. Make the third one a bar chart, and add a 95th percentile line"
                        : starters[0]
                          ? `e.g. ${starters[0]}`
                          : "Describe the dashboard you want"
                    }
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        if (!isLoading && prompt.trim()) generate();
                      }
                    }}
                  />
                  <Button
                    size="icon"
                    onClick={generate}
                    disabled={isLoading || !prompt.trim()}
                    aria-label={refining ? "Refine" : "Generate"}
                    title={refining ? "Refine" : "Generate"}
                    className="absolute bottom-4 right-2"
                  >
                    {isLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <SendHorizontal className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>
              {(isLoading || finalSpec) && (
                <div className="flex items-center gap-3">
                  {isLoading && (
                    <Button variant="ghost" size="sm" onClick={() => stop()}>
                      Stop
                    </Button>
                  )}
                  {finalSpec && (
                    <>
                      <Button variant="secondary" onClick={save} disabled={saving}>
                        <Save className="h-4 w-4" /> Save
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={startOver}
                        disabled={isLoading || saving}
                      >
                        <RotateCcw className="h-4 w-4" /> Start over
                      </Button>
                    </>
                  )}
                </div>
              )}
              {error && (
                <ErrorDisplay
                  error={apiErrorFromThrown(error)}
                  onRetry={generate}
                  retryLabel="Try again"
                  disabled={isLoading}
                />
              )}
              {saveError && (
                <ErrorDisplay
                  error={saveError}
                  onRetry={save}
                  retryLabel="Save again"
                  disabled={saving}
                />
              )}
            </CardContent>
          </Card>

          {refining && (
            <Card>
              <CardHeader>
                <CardTitle>Turns</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <ol className="space-y-2">
                  {history.turns.map((turn, i) => {
                    const active = i === history.index;
                    return (
                      <li
                        key={turn.id}
                        className={`flex items-start justify-between gap-3 border p-3 ${
                          active
                            ? "border-primary bg-surface-2"
                            : "border-border bg-surface"
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                            <span>
                              Turn {i + 1} · {turn.spec.panels.length}{" "}
                              {turn.spec.panels.length === 1 ? "panel" : "panels"}
                              {active && " · previewing"}
                            </span>
                            {/* What produced it, so the cost of a regenerate is
                                visible. A turn applied from a template carries
                                no model because nothing was asked of one. */}
                            {turn.model ? (
                              <Badge title="Generation model">{turn.model}</Badge>
                            ) : (
                              <span>no model call</span>
                            )}
                          </div>
                          <p className="mt-1 break-words text-sm text-foreground">
                            {turn.prompt}
                          </p>
                        </div>
                        {!active && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={isLoading}
                            onClick={() => restore(i)}
                          >
                            <Undo2 className="h-4 w-4" /> Restore
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ol>
                {/* Not quite? Ask again for THIS turn with a note about what
                    was wrong, rather than talking the dashboard forward. One
                    model call, and it replaces the turn instead of adding one.
                    Offered only for a turn a model produced. */}
                {history.turns[history.index]?.model && (
                  <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
                    <div className="min-w-48 flex-1">
                      <Label htmlFor="regen-feedback">
                        Not quite — what should change?
                      </Label>
                      <Input
                        id="regen-feedback"
                        value={feedback}
                        placeholder="e.g. fewer panels, and put the error rate first"
                        onChange={(e) => setFeedback(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !isLoading) regenerate();
                        }}
                      />
                    </div>
                    <Button variant="secondary" onClick={regenerate} disabled={isLoading}>
                      <RefreshCw className="h-4 w-4" /> Regenerate
                    </Button>
                  </div>
                )}
                <p className="text-xs text-muted">
                  Nothing is saved until you press Save. Refining from a restored turn
                  drops the turns that followed it, and a regenerate replaces the turn you
                  are previewing.
                </p>
              </CardContent>
            </Card>
          )}

          {/*
            While it streams, the dashboard is drawn as panel-shaped cards
            that fill in as their titles arrive; the JSON is what the finished
            spec is, and stays available behind a disclosure once there is a
            finished spec to read (#72).
          */}
          {isLoading && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>{object?.title || "Generating…"}</span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <GeneratingPanels panels={object?.panels} />
              </CardContent>
            </Card>
          )}

          {!isLoading && finalSpec && (
            <Card>
              <CardHeader>
                <CardTitle>Generated config</CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="max-h-96 overflow-auto border border-border bg-surface p-4 text-xs text-muted">
                  {JSON.stringify(finalSpec, null, 2)}
                </pre>
              </CardContent>
            </Card>
          )}
        </div>
      ) : (
        <section
          role="tabpanel"
          id="new-dashboard-preview-panel"
          aria-labelledby="new-dashboard-preview-tab"
        >
          {finalSpec ? (
            <PreviewDashboard spec={finalSpec} />
          ) : (
            <Card>
              <CardContent className="text-sm text-muted">
                Generate a dashboard in the Chat tab to preview it.
              </CardContent>
            </Card>
          )}
        </section>
      )}

      {picking && source && (
        <TemplatePicker
          workspaceId={source.workspaceId}
          sources={sources
            .filter((s) => s.workspaceId === source.workspaceId)
            .map((s) => ({ id: s.id, name: s.name }))}
          defaultSourceId={source.id}
          applyLabel="Use template"
          onApply={applyTemplate}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}
