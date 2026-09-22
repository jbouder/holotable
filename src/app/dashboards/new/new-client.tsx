"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { experimental_useObject as useObject } from "@ai-sdk/react";
import {
  LayoutTemplate,
  Loader2,
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
  restoreTurn,
  type TurnHistory,
} from "@/lib/dashboard-turns";
import { Button } from "@/components/ui/button";
import { Textarea, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PreviewDashboard } from "@/components/dashboard/PreviewDashboard";
import { ErrorDisplay } from "@/components/ui/error-display";
import { type ApiError, apiErrorFromThrown, readApiError } from "@/lib/errors";
import type { CatalogHealth } from "@/lib/catalog/health";
import {
  CatalogHealthNotice,
  useCatalogRefresh,
} from "@/components/sources/catalog-health";
import { type Template, templateSpec } from "@/lib/templates";
import { TemplatePicker } from "@/components/templates/TemplatePicker";

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
}: {
  sources: SourceOption[];
  model: string;
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

  // The instruction that produced the run in flight, so the finished turn is
  // labelled with what was actually asked rather than whatever is in the box by
  // the time the stream lands.
  const submittedPrompt = React.useRef("");

  const finalSpec = activeSpec(history);
  const refining = history.turns.length > 0;

  const { object, submit, isLoading, error, stop } = useObject({
    api: "/api/generate",
    schema: Dashboard,
    onFinish({ object }) {
      if (!object) return;
      setHistory((h) => appendTurn(h, normalizeTurn(submittedPrompt.current, object)));
      // Clear the box only once the turn has landed, so a failed run keeps the
      // prompt for Try again — and only if the author has not started typing
      // the next follow-up into it while this one streamed.
      setPrompt((p) => (p === submittedPrompt.current ? "" : p));
      setActiveTab("preview");
    },
  });

  function generate() {
    if (!sourceId || !prompt.trim()) return;
    setSaveError(null);
    submittedPrompt.current = prompt;
    // A follow-up sends the previewed spec back as context and gets the whole
    // dashboard again; one model call either way. Nothing is persisted until
    // the author saves.
    submit(
      finalSpec
        ? { mode: "dashboard-refine", sourceId, prompt, current: finalSpec }
        : { mode: "dashboard", sourceId, prompt },
    );
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
    setActiveTab("chat");
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

  // While a turn streams, show the partial object; once it lands (or after a
  // restore) show the turn being previewed, so the JSON always matches the
  // preview tab rather than whichever run happened last.
  const shownSpec = isLoading ? object : finalSpec;

  if (sources.length === 0) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card>
          <CardContent className="text-sm text-muted">
            You have no data sources to build from. Create one under Data sources first.
          </CardContent>
        </Card>
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
          className="flex w-fit rounded-lg border border-border bg-surface p-1"
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
              className={`rounded-md px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
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
                <Label htmlFor="prompt">
                  {refining
                    ? "Refine it — each follow-up is one more turn"
                    : starters.length > 0
                      ? "Describe the dashboard or try one below"
                      : "Describe the dashboard"}
                </Label>
                {!refining && starters.length > 0 && (
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    {starters.map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        disabled={isLoading}
                        onClick={() => setPrompt(preset)}
                        className="rounded-full border border-border bg-surface px-3 py-1 text-xs text-muted transition-colors hover:border-primary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
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
                        className={`flex items-start justify-between gap-3 rounded-lg border p-3 ${
                          active
                            ? "border-primary bg-surface-2"
                            : "border-border bg-surface"
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="text-xs text-muted">
                            Turn {i + 1} · {turn.spec.panels.length}{" "}
                            {turn.spec.panels.length === 1 ? "panel" : "panels"}
                            {active && " · previewing"}
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
                            onClick={() => setHistory((h) => restoreTurn(h, i))}
                          >
                            <Undo2 className="h-4 w-4" /> Restore
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ol>
                <p className="text-xs text-muted">
                  Nothing is saved until you press Save. Refining from a restored turn
                  drops the turns that followed it.
                </p>
              </CardContent>
            </Card>
          )}

          {shownSpec !== undefined && shownSpec !== null && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  {isLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span className="animate-pulse">Generating config…</span>
                    </>
                  ) : (
                    "Generated config"
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="max-h-96 overflow-auto rounded-lg border border-border bg-surface p-4 text-xs text-muted">
                  {JSON.stringify(shownSpec, null, 2)}
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
