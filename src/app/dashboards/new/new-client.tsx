"use client";

import type { EffectiveModel } from "@/lib/ai/model-config";
import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Braces,
  Database,
  LayoutTemplate,
  Lightbulb,
  Loader2,
  Lock,
  RefreshCw,
  RotateCcw,
  Save,
  SendHorizontal,
  Square,
  Trash2,
  Undo2,
} from "lucide-react";
import { type Dashboard, DashboardGenerationSchema, safeParseDashboard } from "@/lib/ir";
import {
  activeSpec,
  appendTurn,
  EMPTY_HISTORY,
  normalizeTurn,
  replaceTurn,
  restoreTurn,
  type TurnHistory,
} from "@/lib/dashboard-turns";
import { usePromptHistory } from "@/components/prompt-history";
import { PROMPT_MAX_LENGTH, promptLabel } from "@/lib/prompt-history";
import { browserStorage } from "@/lib/browser-storage";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label } from "@/components/ui/input";
import { AiUnavailable } from "@/components/ai-unavailable";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from "@/components/ui/menu";
import { Dialog } from "@/components/ui/dialog";
import {
  additionalSourceChoices,
  defaultSourceId,
  MAX_ADDITIONAL_SOURCES,
  pruneAdditionalSources,
  readLastSource,
  toggleAdditionalSource,
  writeLastSource,
} from "@/lib/source-selection";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { PreviewDashboard } from "@/components/dashboard/PreviewDashboard";
import { GeneratingPanels } from "@/components/dashboard/GeneratingPanels";
import { SaveDashboardDialog } from "@/components/dashboard/SaveDashboardDialog";
import { ErrorDisplay } from "@/components/ui/error-display";
import { RepairingNote } from "@/components/repairing-note";
import { useRepairingObject } from "@/components/use-repairing-object";
import { type ApiError, apiErrorFromThrown, readApiError } from "@/lib/errors";
import type { CatalogHealth } from "@/lib/catalog/health";
import {
  CatalogHealthNotice,
  useCatalogRefresh,
} from "@/components/sources/catalog-health";
import { type Template, templateSpec } from "@/lib/templates";
import { TemplatePicker } from "@/components/templates/TemplatePicker";
import { NoSources } from "@/components/onboarding/no-sources";
import { useFlip } from "@/components/use-flip";
import { useReducedMotion } from "@/components/motion-preference";
import { cn } from "@/lib/utils";

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
   * Per source, so switching the picker switches the suggestions.
   */
  starters: string[];
}

/**
 * `/dashboards/new` (#356): the dashboard is the canvas, the conversation sits
 * beside it, and Save is the one primary action.
 *
 * Before the first prompt the author sees the prompt box, the source it will
 * read (a chip, defaulted to the last one used here) and one Ideas menu —
 * starters, recent prompts and templates are all one interaction away rather
 * than on screen at once. After it, the generated dashboard is where they were
 * already looking, with no tab to switch to.
 */
export function NewDashboardClient({
  sources,
  models,
  canManageSources,
}: {
  sources: SourceOption[];
  /**
   * The model a generation in each workspace would use, and why generation
   * cannot be attempted there (no model configured), keyed by workspace id
   * (#331). Decided on the server, the only side with the configuration.
   */
  models: Record<string, EffectiveModel>;
  /**
   * Whether this caller holds `source:manage` anywhere, which decides whether
   * the no-source empty state offers to add one or names who can.
   */
  canManageSources: boolean;
}) {
  const router = useRouter();
  const reducedMotion = useReducedMotion();
  const [sourceId, setSourceIdState] = React.useState<string | null>(
    sources[0]?.id ?? null,
  );
  // The dashboard's other sources (#104): same workspace, at most two more.
  const [additionalIds, setAdditionalIds] = React.useState<string[]>([]);
  const setSourceId = React.useCallback(
    (id: string | null) => {
      setSourceIdState(id);
      setAdditionalIds((ids) => pruneAdditionalSources(ids, sources, id));
    },
    [sources],
  );
  // The source last generated against in this browser, once mounted: storage
  // does not exist on the server, so reading it during render would be a
  // hydration mismatch. Until then the first source stands in, which is also
  // what a first visit gets.
  React.useEffect(() => {
    const remembered = defaultSourceId(sources, readLastSource(browserStorage()));
    if (remembered) setSourceId(remembered);
  }, [sources, setSourceId]);

  const [prompt, setPrompt] = React.useState("");
  const [history, setHistory] = React.useState<TurnHistory>(EMPTY_HISTORY);
  const [saveError, setSaveError] = React.useState<ApiError | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [confirmingSave, setConfirmingSave] = React.useState(false);
  const [showJson, setShowJson] = React.useState(false);
  const [picking, setPicking] = React.useState(false);
  // A source picked while a conversation is open, waiting on "start over?".
  const [pendingSourceId, setPendingSourceId] = React.useState<string | null>(null);
  // Catalog state for the picker, corrected in place by a Refresh from here.
  const catalog = useCatalogRefresh(
    Object.fromEntries(sources.map((s) => [s.id, s.catalog])),
  );
  const source = sources.find((s) => s.id === sourceId);
  const effective = source ? models[source.workspaceId] : undefined;
  const model = effective?.model ?? "";
  const aiUnavailable = effective?.unavailable ?? null;
  const additionalChoices = additionalSourceChoices(sources, sourceId);
  const additionalSources = additionalChoices.filter((s) => additionalIds.includes(s.id));
  // Suggestions for the selected source. Server-built from its catalog, so they
  // change with the source and never describe a table this source cannot read.
  const starters = source?.starters ?? [];

  // Recent prompts for this workspace, offered back from the Ideas menu (#83).
  // Per workspace because a prompt names that workspace's tables; the list
  // lives in `localStorage` and is never sent anywhere — the durable, redacted
  // record of what was asked is the generation log (#23).
  const prompts = usePromptHistory(source?.workspaceId, "dashboard");

  // "Try again" on the turn being previewed: whether its note box is open,
  // and what it says. Both belong to that turn and are cleared when it changes.
  const [retrying, setRetrying] = React.useState(false);
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
  const activeTurn = history.turns[history.index];

  const turnList = React.useRef<HTMLOListElement>(null);
  useFlip(turnList, !reducedMotion);

  const { object, submit, isLoading, error, stop, repairing } = useRepairingObject({
    api: "/api/generate",
    schema: DashboardGenerationSchema,
    onFinish({ object }) {
      if (!object) return;
      const turn = normalizeTurn(running.current.prompt, object, model);
      setHistory((h) =>
        running.current.replacing ? replaceTurn(h, turn) : appendTurn(h, turn),
      );
      setFeedback("");
      setRetrying(false);
      // Clear the box only once the turn has landed, so a failed run keeps the
      // prompt for Try again — and only if the author has not started typing
      // the next follow-up into it while this one streamed.
      setPrompt((p) => (p === running.current.prompt ? "" : p));
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
    writeLastSource(browserStorage(), sourceId);
    running.current = { prompt: input.instruction, replacing: input.replacing };
    submit(
      input.base
        ? {
            mode: "dashboard-refine",
            sourceId,
            ...(additionalIds.length > 0 ? { additionalSourceIds: additionalIds } : {}),
            prompt: input.instruction,
            current: input.base,
          }
        : {
            mode: "dashboard",
            sourceId,
            ...(additionalIds.length > 0 ? { additionalSourceIds: additionalIds } : {}),
            prompt: input.instruction,
          },
    );
  }

  function generate() {
    if (!sourceId || !prompt.trim() || isLoading || aiUnavailable) return;
    prompts.remember(prompt);
    // A follow-up sends the previewed spec back as context and gets the whole
    // dashboard again; one model call either way. Nothing is persisted until
    // the author saves.
    runGeneration({ instruction: prompt, base: finalSpec, replacing: false });
  }

  /**
   * Ask again for the turn being previewed, with an optional note about what
   * was wrong.
   *
   * One model call, carrying the turn's own prompt, the spec it was generated
   * from, and the feedback. It replaces that turn rather than adding one: the
   * author is not taking another step, they are asking for a different answer
   * to the step they are looking at.
   */
  function regenerate() {
    if (!activeTurn || isLoading || aiUnavailable) return;
    const note = feedback.trim();
    const instruction = note
      ? `${activeTurn.prompt}\n\nAdditional feedback: ${note}`.slice(0, PROMPT_MAX_LENGTH)
      : activeTurn.prompt;
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
    // A template is built over one source.
    setAdditionalIds([]);
    setSaveError(null);
    setPicking(false);
  }

  function startOver() {
    if (isLoading) stop();
    setHistory(EMPTY_HISTORY);
    setSaveError(null);
    setPrompt("");
    setFeedback("");
    setRetrying(false);
  }

  /**
   * Every panel's `query.sourceId` must match the source the spec was
   * generated against, so a conversation cannot change source midway. Picking
   * another one asks to start over instead of being silently refused.
   */
  function chooseSource(id: string) {
    if (id === sourceId) return;
    if (refining) setPendingSourceId(id);
    else setSourceId(id);
  }

  /** Preview an earlier turn. The feedback box belongs to the turn it was typed on. */
  function restore(index: number) {
    setHistory((h) => restoreTurn(h, index));
    setFeedback("");
    setRetrying(false);
  }

  async function save(title: string) {
    if (!finalSpec) return;
    setSaving(true);
    setSaveError(null);
    const parsed = safeParseDashboard({ ...finalSpec, title });
    if (!parsed.success) {
      setSaveError({
        error: `The generated spec is invalid: ${parsed.error.issues[0]?.message ?? "validation failed"}`,
        kind: "validation",
      });
      setSaving(false);
      return;
    }
    let res: Response;
    try {
      res = await fetch("/api/dashboards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec: parsed.data }),
      });
    } catch (thrown) {
      setSaving(false);
      setSaveError(apiErrorFromThrown(thrown));
      return;
    }
    if (!res.ok) {
      setSaving(false);
      setSaveError(await readApiError(res));
      return;
    }
    const body = await res.json();
    router.push(`/dashboards/${body.dashboard.id}`);
  }

  const description =
    "Describe the dashboard you want in plain English. It is generated as a validated spec and previewed with live data; refine it, then save it.";

  if (sources.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="New dashboard" description={description} />
        <NoSources canManageSources={canManageSources} />
      </div>
    );
  }

  const pendingSource = sources.find((s) => s.id === pendingSourceId);

  return (
    <div className="space-y-6">
      <PageHeader title="New dashboard" description={description} />

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
        {/*
          The canvas. While a turn streams it is the panel-shaped skeleton that
          fills in as titles arrive (#72); once a turn lands it is that turn's
          live preview. Before the first prompt there is nothing to show, and
          on a narrow screen it takes no room until there is.
        */}
        <section
          aria-label="Dashboard preview"
          className={cn(
            "min-w-0 space-y-4",
            !isLoading && !finalSpec && "hidden lg:block",
          )}
        >
          {isLoading ? (
            <Card className="fade-in">
              <CardContent className="space-y-4">
                <h2 className="flex items-center gap-2 text-lg font-semibold">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>{object?.title || "Generating…"}</span>
                </h2>
                <GeneratingPanels panels={object?.panels} />
              </CardContent>
            </Card>
          ) : finalSpec ? (
            <div className="fade-in space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-semibold">{finalSpec.title}</h2>
                  <p className="text-xs text-muted">
                    Version {history.index + 1} of {history.turns.length} ·{" "}
                    {finalSpec.panels.length}{" "}
                    {finalSpec.panels.length === 1 ? "panel" : "panels"} · not saved yet
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setShowJson(true)}>
                    <Braces className="h-4 w-4" /> View JSON
                  </Button>
                  <Button
                    onClick={() => {
                      setSaveError(null);
                      setConfirmingSave(true);
                    }}
                    disabled={saving}
                  >
                    <Save className="h-4 w-4" /> Save dashboard
                  </Button>
                </div>
              </div>
              <PreviewDashboard spec={finalSpec} />
            </div>
          ) : (
            <div className="flex min-h-80 items-center justify-center border border-dashed border-border p-8 text-center text-sm text-muted">
              Your dashboard appears here as it is generated, with live data from the
              source you picked.
            </div>
          )}
        </section>

        {/* The conversation: what was asked, then the box to ask the next thing. */}
        <aside aria-label="Conversation" className="min-w-0 lg:sticky lg:top-20">
          <Card>
            <CardContent className="space-y-4">
              {refining && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="text-sm font-medium text-muted">Versions</h2>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={startOver}
                      disabled={saving}
                    >
                      <RotateCcw className="h-4 w-4" /> Start over
                    </Button>
                  </div>
                  <ol ref={turnList} className="space-y-2">
                    {history.turns.map((turn, i) => {
                      const active = i === history.index;
                      return (
                        <li
                          key={turn.id}
                          data-flip-id={turn.id}
                          aria-current={active ? "true" : undefined}
                          className={cn(
                            "border p-3",
                            active
                              ? "border-primary bg-surface-2"
                              : "border-border bg-surface",
                          )}
                        >
                          <p className="break-words text-sm text-foreground">
                            {turn.prompt}
                          </p>
                          <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                            <span className="text-xs text-muted">
                              Version {i + 1} · {turn.spec.panels.length}{" "}
                              {turn.spec.panels.length === 1 ? "panel" : "panels"}
                              {/* A template turn cost nothing; say so. */}
                              {!turn.model && " · no model call"}
                              {active && " · showing"}
                            </span>
                            {active ? (
                              // Ask again for THIS turn, rather than talking the
                              // dashboard forward. Only for a turn a model made.
                              turn.model &&
                              !retrying && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={isLoading || aiUnavailable !== null}
                                  onClick={() => setRetrying(true)}
                                >
                                  <RefreshCw className="h-4 w-4" /> Try again
                                </Button>
                              )
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={isLoading}
                                onClick={() => restore(i)}
                                aria-label={`Restore version ${i + 1}`}
                              >
                                <Undo2 className="h-4 w-4" /> Restore
                              </Button>
                            )}
                          </div>
                          {active && retrying && (
                            <form
                              className="fade-in mt-3 space-y-2 border-t border-border pt-3"
                              onSubmit={(e) => {
                                e.preventDefault();
                                regenerate();
                              }}
                            >
                              <Label htmlFor="regen-feedback">
                                What should change? (optional)
                              </Label>
                              <Input
                                id="regen-feedback"
                                value={feedback}
                                autoFocus
                                placeholder="e.g. fewer panels, and put the error rate first"
                                onChange={(e) => setFeedback(e.target.value)}
                              />
                              <div className="flex justify-end gap-2">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => {
                                    setRetrying(false);
                                    setFeedback("");
                                  }}
                                >
                                  Cancel
                                </Button>
                                <Button
                                  type="submit"
                                  variant="secondary"
                                  size="sm"
                                  disabled={isLoading}
                                >
                                  <RefreshCw className="h-4 w-4" /> Regenerate
                                </Button>
                              </div>
                            </form>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                  <p className="text-xs text-muted">
                    Nothing is saved until you save the dashboard. Try again replaces the
                    version you are looking at; refining an earlier one drops the versions
                    after it.
                  </p>
                </div>
              )}

              <div className={cn("space-y-3", refining && "border-t border-border pt-4")}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {source && (
                    <SourceMenu
                      sources={sources}
                      source={source}
                      locked={refining}
                      additionalChoices={additionalChoices}
                      additionalIds={additionalIds}
                      disabled={isLoading}
                      onChoose={chooseSource}
                      onToggleAdditional={(id, next) =>
                        setAdditionalIds((ids) => toggleAdditionalSource(ids, id, next))
                      }
                    />
                  )}
                  <Menu
                    label="Ideas: suggestions, recent prompts and templates"
                    className="h-8 w-auto gap-1.5 px-2 text-sm"
                    panelClassName="max-w-md"
                    trigger={
                      <>
                        <Lightbulb className="h-4 w-4" aria-hidden /> Ideas
                      </>
                    }
                  >
                    {starters.length > 0 && (
                      <MenuGroup label="Suggestions">
                        {starters.map((preset) => (
                          <MenuItem
                            key={preset}
                            disabled={isLoading}
                            onClick={() => setPrompt(preset)}
                          >
                            <span className="truncate" title={preset}>
                              {preset}
                            </span>
                          </MenuItem>
                        ))}
                      </MenuGroup>
                    )}
                    {prompts.entries.length > 0 && (
                      <>
                        {starters.length > 0 && <MenuSeparator />}
                        <MenuGroup label="Recent prompts">
                          {prompts.entries.map((entry) => (
                            <MenuItem
                              key={entry.prompt}
                              disabled={isLoading}
                              onClick={() => setPrompt(entry.prompt)}
                            >
                              <span className="truncate" title={entry.prompt}>
                                {promptLabel(entry.prompt)}
                              </span>
                            </MenuItem>
                          ))}
                          <MenuItem onClick={prompts.clear}>
                            <Trash2 className="h-4 w-4" /> Clear recent prompts
                          </MenuItem>
                        </MenuGroup>
                      </>
                    )}
                    {(starters.length > 0 || prompts.entries.length > 0) && (
                      <MenuSeparator />
                    )}
                    {/* A template starts a conversation; it cannot join one. */}
                    <MenuItem
                      disabled={refining || isLoading}
                      onClick={() => setPicking(true)}
                    >
                      <LayoutTemplate className="h-4 w-4" /> Start from a template…
                    </MenuItem>
                  </Menu>
                </div>

                {[source, ...additionalSources].map(
                  (s) =>
                    s && (
                      <CatalogHealthNotice
                        key={s.id}
                        source={s}
                        health={catalog.health[s.id]}
                        canRefresh={s.canRefresh}
                        onRefreshed={(health) => catalog.update(s.id, health)}
                      />
                    ),
                )}
                {aiUnavailable && <AiUnavailable message={aiUnavailable} />}

                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    generate();
                  }}
                >
                  <Label htmlFor="prompt">
                    {refining ? "Refine it" : "Describe the dashboard"}
                  </Label>
                  <div className="relative">
                    <Textarea
                      id="prompt"
                      disabled={aiUnavailable !== null}
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
                          generate();
                        }
                      }}
                    />
                    {isLoading ? (
                      <Button
                        type="button"
                        size="icon"
                        variant="secondary"
                        onClick={() => stop()}
                        aria-label="Stop"
                        title="Stop"
                        className="absolute bottom-4 right-2"
                      >
                        <Square className="h-4 w-4" />
                      </Button>
                    ) : (
                      <Button
                        type="submit"
                        size="icon"
                        disabled={!prompt.trim() || aiUnavailable !== null}
                        aria-label={refining ? "Refine" : "Generate"}
                        title={refining ? "Refine" : "Generate"}
                        className="absolute bottom-4 right-2"
                      >
                        <SendHorizontal className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                  {model && (
                    <p className="text-xs text-muted">
                      Generates with <span className="text-foreground">{model}</span>.
                      Enter sends, Shift+Enter adds a line.
                    </p>
                  )}
                </form>

                <RepairingNote show={repairing} />
                {error && (
                  <ErrorDisplay
                    error={apiErrorFromThrown(error)}
                    onRetry={generate}
                    retryLabel="Try again"
                    disabled={isLoading}
                  />
                )}
              </div>
            </CardContent>
          </Card>
        </aside>
      </div>

      {finalSpec && source && (
        <SaveDashboardDialog
          open={confirmingSave}
          onOpenChange={setConfirmingSave}
          defaultTitle={finalSpec.title}
          workspaceId={source.workspaceId}
          saving={saving}
          error={saveError}
          onSave={(title) => void save(title)}
        />
      )}

      <Dialog
        open={showJson && finalSpec !== null}
        onOpenChange={setShowJson}
        title="Dashboard spec"
      >
        <p className="mb-3 text-sm text-muted">
          The validated spec this version would save. It holds queries and layout, never
          data or connection details.
        </p>
        <pre className="max-h-[60vh] overflow-auto border border-border bg-surface-2 p-4 text-xs text-muted">
          {JSON.stringify(finalSpec, null, 2)}
        </pre>
      </Dialog>

      <Dialog
        open={pendingSource !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingSourceId(null);
        }}
        title="Start over with another source?"
        className="max-w-md"
      >
        <div className="space-y-4">
          <p className="text-sm text-muted">
            Every panel reads the source it was generated against, so switching to{" "}
            <span className="text-foreground">{pendingSource?.name}</span> starts a new
            conversation. Your {history.turns.length} unsaved{" "}
            {history.turns.length === 1 ? "version is" : "versions are"} discarded.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setPendingSourceId(null)}>
              Keep this source
            </Button>
            <Button
              onClick={() => {
                if (!pendingSourceId) return;
                startOver();
                setSourceId(pendingSourceId);
                setPendingSourceId(null);
              }}
            >
              Start over
            </Button>
          </div>
        </div>
      </Dialog>

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

/**
 * The source chip: what the dashboard will read, and the one place to change
 * it or add the others (#104). A menu of radio and checkbox items rather than
 * a form field, so before the first prompt it is one compact control.
 */
function SourceMenu({
  sources,
  source,
  locked,
  additionalChoices,
  additionalIds,
  disabled,
  onChoose,
  onToggleAdditional,
}: {
  sources: SourceOption[];
  source: SourceOption;
  /** A conversation is open: choosing another source asks to start over. */
  locked: boolean;
  additionalChoices: SourceOption[];
  additionalIds: string[];
  disabled: boolean;
  onChoose: (id: string) => void;
  onToggleAdditional: (id: string, checked: boolean) => void;
}) {
  const extra = additionalIds.length;
  return (
    <Menu
      label={`Data source: ${source.name}, workspace ${source.workspaceId}${extra > 0 ? `, and ${extra} more` : ""}`}
      className="h-8 w-auto max-w-full gap-1.5 border border-border bg-surface px-2 text-sm text-foreground"
      panelClassName="max-w-sm"
      trigger={
        <>
          {locked ? (
            <Lock className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
          ) : (
            <Database className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
          )}
          <span className="truncate">{source.name}</span>
          <span className="shrink-0 text-xs text-muted">
            {source.workspaceId}
            {extra > 0 && ` +${extra}`}
          </span>
        </>
      }
    >
      <MenuRadioGroup
        label={locked ? "Source (changing it starts over)" : "Source"}
        value={source.id}
        onValueChange={onChoose}
      >
        {sources.map((s) => (
          <MenuRadioItem key={s.id} value={s.id}>
            <span className="truncate">{s.name}</span>
            <span className="text-xs text-muted">{s.workspaceId}</span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
      {additionalChoices.length > 0 && (
        <>
          <MenuSeparator />
          <MenuGroup label={`Also use (up to ${MAX_ADDITIONAL_SOURCES} more)`}>
            {additionalChoices.map((s) => {
              const checked = additionalIds.includes(s.id);
              return (
                <MenuCheckboxItem
                  key={s.id}
                  checked={checked}
                  disabled={
                    locked ||
                    disabled ||
                    (!checked && additionalIds.length >= MAX_ADDITIONAL_SOURCES)
                  }
                  onCheckedChange={(next) => onToggleAdditional(s.id, next)}
                >
                  <span className="truncate">{s.name}</span>
                </MenuCheckboxItem>
              );
            })}
          </MenuGroup>
          <p className="px-2 pt-1 pb-1.5 text-xs text-muted">
            {locked
              ? "Fixed for this conversation; start over to change them."
              : "Each panel reads one source; a query never combines two."}
          </p>
        </>
      )}
    </Menu>
  );
}
