"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Keyboard,
  Info,
  LayoutTemplate,
  Loader2,
  MoreHorizontal,
  Plus,
  Redo2,
  Save,
  SendHorizontal,
  Sparkles,
  Undo2,
  Unplug,
} from "lucide-react";
import {
  type Dashboard,
  hasQuery,
  declaredVariables,
  Panel,
  panelTimeRange,
  safeParseDashboard,
} from "@/lib/ir";
import { panelKind } from "@/lib/panels/registry";
import { autoLayoutPanels } from "@/lib/layout";
import { duplicatePanel } from "@/lib/panel-list";
import { isStarterSql, starterPanel } from "@/lib/panel-starter";
import { AiUnavailable } from "@/components/ai-unavailable";
import { Button } from "@/components/ui/button";
import { buttonClassName } from "@/components/ui/button-styles";
import { Input, Textarea, Label } from "@/components/ui/input";
import { Menu, MenuItem } from "@/components/ui/menu";
import { Popover } from "@/components/ui/popover";
import { PanelView } from "@/components/dashboard/PanelView";
import { PanelLayoutGrid } from "@/components/dashboard/PanelLayoutGrid";
import { usePreviewStates } from "@/components/dashboard/use-preview-states";
import { PanelDiffView } from "@/components/dashboard/PanelDiffView";
import { PromptHistoryMenu, usePromptHistory } from "@/components/prompt-history";
import { acceptedPanel, diffPanels, type PanelDraft } from "@/lib/panel-diff";
import { missingSourceIds, panelsUsingSource, repointPanels } from "@/lib/panel-repoint";
import { RepointPanelsDialog } from "@/components/dashboard/RepointPanelsDialog";
import { ErrorDisplay } from "@/components/ui/error-display";
import { RepairingNote } from "@/components/repairing-note";
import { useRepairingObject } from "@/components/use-repairing-object";
import { type ApiError, apiErrorFromThrown, readApiError } from "@/lib/errors";
import { appendTemplate, type Template } from "@/lib/templates";
import { useSaveAsTemplate } from "@/components/templates/SaveAsTemplate";
import { TemplatePicker } from "@/components/templates/TemplatePicker";
import { DraftBanner } from "@/components/editor/DraftBanner";
import {
  type EditIntent,
  PanelInspector,
  type SourceOption,
} from "@/components/editor/PanelInspector";
import { DashboardSettings } from "@/components/editor/DashboardSettings";
import { Notice } from "@/components/notice";
import { Dialog } from "@/components/ui/dialog";
import { LeaveGuardDialog } from "@/components/editor/LeaveGuardDialog";
import { ShortcutsDialog } from "@/components/editor/ShortcutsDialog";
import { DashboardDetailsDialog } from "@/components/dashboard/DashboardDetailsDialog";
import { useHistory } from "@/lib/editor/use-history";
import { formatShortcut, useIsMac, useShortcuts } from "@/lib/editor/use-shortcuts";
import { usePreviewValues } from "@/components/editor/variables-editor";
import { bindShortcuts, EDITOR_SHORTCUTS } from "@/lib/shortcuts";
import {
  interceptedHref,
  isDirty,
  relativeTime,
  UNLOAD_PROMPT,
  VERSION_NOTE_MAX,
} from "@/lib/editor/session";
import {
  browserDraftStorage,
  clearDraft,
  DRAFT_DEBOUNCE_MS,
  draftKey,
  draftOffer,
  type DraftOffer,
  type DraftStorage,
  pruneDrafts,
  readDraft,
  writeDraft,
} from "@/lib/editor/drafts";

/** Row height on the canvas: the viewer's, so a panel is edited at the size readers see. */
const CANVAS_ROW_HEIGHT = 84;

/**
 * `/dashboards/[id]/edit` (#357): the live dashboard is the canvas, the
 * inspector beside it edits whatever is selected — a panel, or with nothing
 * selected the dashboard itself — and there is one Save.
 *
 * Every capability of the old two-tab editor is still here; what changed is
 * where it sits. Order, position and size are edited only on the canvas.
 */
export function EditDashboardClient({
  dashboardId,
  workspaceId,
  initialSpec,
  initialPanelId,
  initialVersion,
  updatedAt,
  userSub,
  sources,
  metadata,
  tagSuggestions = [],
  model,
  aiUnavailable,
}: {
  dashboardId: string;
  /** The dashboard's own workspace: where a template is saved and read from. */
  workspaceId: string;
  initialSpec: Dashboard;
  /** Panel to open selected; ignored when it is not in the spec. */
  initialPanelId?: string;
  /** Version of the spec this editor opened on; the draft conflict check reads it. */
  initialVersion: number;
  /** When that version was written, for the header's 'last saved' line. */
  updatedAt: string;
  /** The viewer's subject, which scopes their drafts within this browser. */
  userSub: string;
  sources: SourceOption[];
  /**
   * Description and tags as stored on the dashboard row. They are NOT spec,
   * so they are not in `history`, are not part of `dirty`, and are saved the
   * moment the details dialog is confirmed rather than by Save version (#119).
   */
  metadata: { description: string | null; tags: string[] };
  /** Tags already in use in this workspace, offered in the dialog. */
  tagSuggestions?: string[];
  /** The configured generation model, shown on a proposal so its cost is visible. */
  model: string;
  /**
   * Why generation cannot be attempted on this server (no model configured),
   * or null. Decided on the server, which is the only side with the env.
   */
  aiUnavailable: string | null;
}) {
  const router = useRouter();
  const mac = useIsMac();
  // Every spec mutation goes through `history.set`, which is what makes an
  // accidental delete or a mistaken Arrange recoverable (#81).
  const history = useHistory<Dashboard>(initialSpec);
  const spec = history.state;
  // What the previews bind for the dashboard's variables (#67).
  const previewValues = usePreviewValues(spec.variables);

  // What the server holds. The dirty flag is the difference between this and
  // the working spec, so an edit that lands back on the saved value — typing a
  // character and deleting it — is correctly not a change (#117).
  const [savedSpec, setSavedSpec] = React.useState<Dashboard>(initialSpec);
  const [version, setVersion] = React.useState(initialVersion);
  const [savedAt, setSavedAt] = React.useState(() => {
    const parsed = Date.parse(updatedAt);
    return Number.isNaN(parsed) ? 0 : parsed;
  });
  const [note, setNote] = React.useState("");
  const [details, setDetails] = React.useState(metadata);
  const [showDetails, setShowDetails] = React.useState(false);
  const dirty = isDirty(spec, savedSpec);

  // Nothing selected shows the dashboard's own settings; `?panel=` (how
  // Explore hands off a saved result) opens on that panel instead.
  const [selectedId, setSelectedId] = React.useState<string | null>(
    initialSpec.panels.find((p) => p.id === initialPanelId)?.id ?? null,
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [nlPrompt, setNlPrompt] = React.useState("");
  // Recent panel-edit prompts for this workspace, offered back on the box
  // (#83). A separate list from the create box: "make it a bar chart" is a
  // panel edit and is nonsense as a dashboard description.
  const prompts = usePromptHistory(workspaceId, "panel");
  const [showShortcuts, setShowShortcuts] = React.useState(false);
  /** Where a guarded click wanted to go, held until the author answers. */
  const [pendingHref, setPendingHref] = React.useState<string | null>(null);
  // A generated panel waits here to be accepted or rejected. It holds the id
  // of the panel it would replace rather than a copy of it, so a manual edit
  // made while the proposal is open shows up in the diff instead of being
  // silently discarded by the Accept. `panel` is null until the object lands.
  const [proposal, setProposal] = React.useState<{
    panelId: string;
    prompt: string;
    panel: Panel | null;
  } | null>(null);
  // A re-point under review: the removed source it moves off, and the panels
  // it covers. One panel for the editor's own call to action, every panel on
  // that source for the bulk fix in the banner.
  const [repointing, setRepointing] = React.useState<{
    sourceId: string;
    panelIds: string[];
  } | null>(null);
  const [picking, setPicking] = React.useState(false);
  // A panel whose deletion is waiting on an answer. Only panels that have been
  // worked on get this far; see `removePanel`.
  const [confirmDelete, setConfirmDelete] = React.useState<Panel | null>(null);

  // Wall clock for the relative timestamps, resolved after mount: rendering
  // "2 minutes ago" on the server would be a hydration mismatch by definition.
  const [now, setNow] = React.useState(0);
  React.useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const selected = spec.panels.find((p) => p.id === selectedId) ?? null;
  // Sources a panel names that the page did not load: tombstoned, deleted, or
  // in another workspace. All three fail the save the same way, and all three
  // are fixed by re-pointing the panels off them.
  const missingSources = missingSourceIds(
    spec.panels,
    sources.map((s) => s.id),
  );
  const repointPanelSet = repointing
    ? spec.panels.filter(hasQuery).filter((p) => repointing.panelIds.includes(p.id))
    : [];
  const proposalBase = proposal
    ? (spec.panels.find((p) => p.id === proposal.panelId) ?? null)
    : null;

  // The canvas: every panel's guarded preview, re-run only when its query,
  // window or variables change, and only once typing pauses (#357).
  const canvas = usePreviewStates(spec, previewValues, { debounceMs: 800 });

  // "Save as template" from the panel's actions menu. The dialog lives here,
  // outside the menu, which unmounts when it closes.
  const panelTemplate = useSaveAsTemplate({
    workspaceId,
    subject: selected
      ? { kind: "panel", panel: selected }
      : { kind: "dashboard", dashboard: spec },
    defaultName: selected?.title ?? spec.title,
  });

  const {
    object,
    submit,
    stop,
    isLoading,
    error: genError,
    repairing,
  } = useRepairingObject({
    api: "/api/generate",
    schema: Panel,
    onFinish({ object }) {
      // Deliberately does NOT apply anything: the generation lands in the
      // proposal and the author accepts it, or it never touches the spec.
      if (object) setProposal((p) => (p ? { ...p, panel: object } : p));
    },
  });

  /* ---------------------------------------------------------------------- */
  /* Draft autosave (#118)                                                   */
  /* ---------------------------------------------------------------------- */

  const storageRef = React.useRef<DraftStorage | null>(null);
  const [offer, setOffer] = React.useState<DraftOffer>({ kind: "none" });
  /** Until the stored draft has been read, autosave must not touch storage. */
  const [draftRead, setDraftRead] = React.useState(false);
  const key = draftKey(dashboardId, userSub);

  React.useEffect(() => {
    const storage = browserDraftStorage();
    storageRef.current = storage;
    const at = Date.now();
    // Drafts for dashboards nobody will reopen are what makes the per-key cap
    // insufficient on its own.
    pruneDrafts(storage, at);
    setOffer(
      draftOffer({
        draft: readDraft(storage, key),
        dashboardId,
        currentVersion: initialVersion,
        savedSpec: initialSpec,
        now: at,
      }),
    );
    setDraftRead(true);
  }, [key, dashboardId, initialVersion, initialSpec]);

  React.useEffect(() => {
    if (!draftRead) return;
    const storage = storageRef.current;
    if (!dirty) {
      // Only once the offer has been answered: clearing now would throw away
      // the very draft the banner is offering.
      if (offer.kind === "none") clearDraft(storage, key);
      return;
    }
    // Editing past the banner is itself an answer — the author has chosen to
    // work from the saved version — and from here on it is their NEW work that
    // autosave has to protect. Leaving the banner up with autosave paused would
    // be the one state in which the editor quietly stops keeping a draft.
    if (offer.kind !== "none") setOffer({ kind: "none" });
    const timer = setTimeout(() => {
      writeDraft(storage, key, {
        dashboardId,
        baseVersion: version,
        savedAt: Date.now(),
        spec,
      });
    }, DRAFT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draftRead, offer.kind, dirty, spec, key, dashboardId, version]);

  function restoreDraft() {
    if (offer.kind === "none") return;
    // Restoring is itself an edit, so it is one step to undo rather than a
    // decision the author cannot take back.
    history.set(offer.draft.spec, { action: "restore autosaved changes" });
    setSelectedId(null);
    setOffer({ kind: "none" });
  }

  function discardDraft() {
    clearDraft(storageRef.current, key);
    setOffer({ kind: "none" });
  }

  /* ---------------------------------------------------------------------- */
  /* Spec mutations — each one an undo step                                  */
  /* ---------------------------------------------------------------------- */

  function updateSpec(patch: Partial<Dashboard>, intent: EditIntent) {
    history.set((s) => ({ ...s, ...patch }), intent);
  }

  function arrangeColumns(columns: number) {
    history.set((s) => ({ ...s, panels: autoLayoutPanels(s.panels, columns) }), {
      action: `arrange ${columns}-up`,
    });
  }

  /** One drag, resize or nudge from the arranger: one change to the spec. */
  function setPanels(panels: Panel[]) {
    // A drag emits a change per pointer move; they coalesce into one step.
    history.set((s) => ({ ...s, panels }), { action: "move panels", key: "arrange" });
  }

  function updatePanel(id: string, fn: (p: Panel) => Panel, intent: EditIntent) {
    history.set(
      (s) => ({ ...s, panels: s.panels.map((p) => (p.id === id ? fn(p) : p)) }),
      intent,
    );
  }

  /**
   * Add a panel at the bottom of the grid, starting from a query built out of
   * the selected source's own catalog (#112) rather than `SELECT 1 AS value`.
   *
   * `describe` focuses the natural-language box instead of the SQL: the panel
   * still lands as a starter, but the author's next act is to say what they
   * want and review it as a diff, which is the same flow as any other
   * natural-language edit (#111).
   */
  function addPanel(describe = false) {
    if (sources.length === 0) return;
    const id = `panel-${Date.now().toString(36)}`;
    const maxY = spec.panels.reduce((m, p) => Math.max(m, p.layout.y + p.layout.h), 0);
    const source = sources[0];
    const panel = starterPanel(id, source.id, source.catalog, {
      x: 0,
      y: maxY,
      w: 6,
      h: 4,
    });
    history.set((s) => ({ ...s, panels: [...s.panels, panel] }), {
      action: "add panel",
    });
    setSelectedId(id);
    if (describe) {
      // After the render that mounts the editor for the new panel.
      requestAnimationFrame(() => document.getElementById("nl")?.focus());
    }
  }

  /* --- Panel list actions (#113). Each one is a single history entry. ----- */

  function duplicate(id: string) {
    const next = duplicatePanel(spec.panels, id);
    if (!next) return;
    history.set((s) => ({ ...s, panels: next.panels }), { action: "duplicate panel" });
    selectPanel(next.id);
  }

  /**
   * Delete, asking first when there is work to lose.
   *
   * Deleting is undoable, so a confirmation on every panel would be noise. It
   * is worth one once the SQL is no longer the starter the editor wrote —
   * which is the same question `isStarterSql` answers for the source the panel
   * actually points at, not the first one in the list.
   */
  function removePanel(id: string) {
    const panel = spec.panels.find((p) => p.id === id);
    if (!panel) return;
    if (!hasQuery(panel)) {
      // A text panel (#202) is worth asking about once it says something
      // other than what it started with.
      const starter = panelKind(panel.viz).starterOptions?.(panel.title);
      if (starter?.content === panel.options?.content) deletePanel(id);
      else setConfirmDelete(panel);
      return;
    }
    const catalog = sources.find((s) => s.id === panel.query.sourceId)?.catalog ?? null;
    if (isStarterSql(panel.query.sql, catalog)) deletePanel(id);
    else setConfirmDelete(panel);
  }

  /**
   * Bring a template's panels in at the bottom of the grid, already pointed at
   * the source chosen in the picker. One history entry, so it is one step to
   * undo; nothing is written until the existing Save appends a version, which
   * re-validates every statement server-side against that source.
   */
  function applyTemplate(input: { template: Template; sourceId: string }) {
    const next = appendTemplate(spec, input.template.body, input.sourceId);
    history.set(next, { action: `add panels from "${input.template.name}"` });
    setSelectedId(next.panels[next.panels.length - 1]?.id ?? null);
    setPicking(false);
  }

  function deletePanel(id: string) {
    setConfirmDelete(null);
    history.set((s) => ({ ...s, panels: s.panels.filter((p) => p.id !== id) }), {
      action: "delete panel",
    });
    if (proposal?.panelId === id) discardProposal();
    // Back to the dashboard's settings rather than onto some other panel the
    // author did not pick.
    if (selectedId === id) setSelectedId(null);
  }

  /** Drop the proposal, cancelling the run behind it if one is still going. */
  function discardProposal() {
    if (isLoading) stop();
    setProposal(null);
  }

  function selectPanel(id: string | null) {
    if (id === selectedId) return;
    discardProposal();
    setSelectedId(id);
  }

  /**
   * One model call. `base` is what the model is asked to change and what the
   * diff is against — on a regenerate that is still the panel in the spec, not
   * the generation being reviewed, so pressing Regenerate twice cannot compound
   * the model's own output.
   */
  function generatePanel(base: Panel, prompt: string, feedback = "") {
    if (aiUnavailable) return;
    const instruction = feedback.trim()
      ? `${prompt}\n\nAdditional feedback: ${feedback.trim()}`.slice(0, 4000)
      : prompt;
    // A text panel (#202) has no source of its own; the model is still shown
    // the dashboard's, which is what its prose is about.
    const sourceId =
      base.query?.sourceId ??
      spec.panels.find(hasQuery)?.query.sourceId ??
      sources[0]?.id;
    if (!sourceId) return;
    setProposal({ panelId: base.id, prompt, panel: null });
    submit({
      mode: "panel",
      sourceId,
      prompt: instruction,
      current: base,
      // So a link back to this dashboard is written as a self link (#375).
      dashboardId,
    });
  }

  function runNlEdit() {
    if (!selected || !nlPrompt.trim() || isLoading) return;
    // Remembered on submit, not on success: a run that failed, or one whose
    // result was rejected, is the prompt most likely to be wanted back.
    prompts.remember(nlPrompt);
    generatePanel(selected, nlPrompt);
  }

  function acceptProposal() {
    const generated = proposal?.panel;
    if (!generated || !proposalBase) return;
    // One history entry, so rejecting a generated change after the fact is one
    // undo rather than a field-by-field trail.
    updatePanel(proposalBase.id, () => acceptedPanel(proposalBase, generated), {
      action: "apply natural-language edit",
    });
    setProposal(null);
    setNlPrompt("");
  }

  /**
   * Move the reviewed panels onto their new source. One history entry, so a
   * bulk re-point is one step to undo rather than one per panel — and nothing
   * is written here: the change is saved by the existing Save version, which
   * appends a version and re-validates every statement server-side.
   */
  function applyRepoint(input: { sourceId: string; panelIds: string[] }) {
    history.set((s) => ({ ...s, panels: repointPanels(s.panels, input) }), {
      action: "re-point panels",
    });
    setRepointing(null);
  }

  /* ---------------------------------------------------------------------- */
  /* Saving (#117)                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Write a new version. Returns whether it landed, so the callers that go
   * somewhere afterwards only go on success — a failed save leaves the author
   * in the editor with their changes and the error, which is the whole point of
   * splitting the navigation out of the save.
   */
  async function save(options: { navigate: boolean } = { navigate: false }) {
    setSaving(true);
    setError(null);
    const parsed = safeParseDashboard(spec);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError({
        error: issue
          ? `${issue.path.join(".") || "spec"}: ${issue.message}`
          : "The dashboard spec is not valid.",
        kind: "validation",
      });
      setSaving(false);
      return false;
    }
    const trimmed = note.trim();
    let res: Response;
    try {
      res = await fetch(`/api/dashboards/${dashboardId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec: parsed.data, note: trimmed || undefined }),
      });
    } catch (thrown) {
      setSaving(false);
      setError(apiErrorFromThrown(thrown));
      return false;
    }
    setSaving(false);
    if (!res.ok) {
      setError(await readApiError(res));
      return false;
    }
    const body = (await res.json().catch(() => null)) as {
      dashboard?: { version?: number };
    } | null;
    setSavedSpec(parsed.data);
    setVersion((v) => body?.dashboard?.version ?? v + 1);
    setSavedAt(Date.now());
    setNote("");
    // The saved version now holds everything the draft did.
    clearDraft(storageRef.current, key);
    setOffer({ kind: "none" });
    if (options.navigate) router.push(`/dashboards/${dashboardId}`);
    return true;
  }

  /* ---------------------------------------------------------------------- */
  /* Leaving with unsaved changes (#117)                                     */
  /* ---------------------------------------------------------------------- */

  React.useEffect(() => {
    if (!dirty) return;
    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = UNLOAD_PROMPT;
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  React.useEffect(() => {
    if (!dirty) return;
    let opening: ReturnType<typeof setTimeout> | undefined;
    // The App Router exposes no navigation event, so the guard intercepts the
    // click that would START the navigation. Capture phase, so it runs before
    // the Link that would otherwise have already pushed.
    function onClick(event: MouseEvent) {
      const anchor = (event.target as HTMLElement | null)?.closest?.("a");
      if (!anchor) return;
      const href = interceptedHref({
        href: anchor.getAttribute("href"),
        target: anchor.getAttribute("target"),
        download: anchor.hasAttribute("download"),
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        button: event.button,
        origin: window.location.origin,
        currentPath: window.location.pathname,
      });
      if (!href) return;
      event.preventDefault();
      event.stopPropagation();
      // Opened on the NEXT task, not in this handler. A dialog mounted while
      // its own click is still being dispatched reads the tail of that click as
      // a press outside itself and closes again — the link would be swallowed
      // with nothing shown, which is worse than either answer.
      opening = setTimeout(() => setPendingHref(href), 0);
    }
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      clearTimeout(opening);
    };
  }, [dirty]);

  /** Go somewhere, asking first when there is unsaved work. */
  function leave(href: string) {
    if (dirty) {
      setPendingHref(href);
      return;
    }
    router.push(href);
  }

  function leaveNow(href: string) {
    clearDraft(storageRef.current, key);
    setPendingHref(null);
    router.push(href);
  }

  /* ---------------------------------------------------------------------- */
  /* Keyboard shortcuts (#121)                                               */
  /* ---------------------------------------------------------------------- */

  const dialogOpen = picking || repointing !== null || pendingHref !== null;
  // The keys and descriptions live in the registry (#217); this only says
  // what each one does here and when it is off.
  const bindings = bindShortcuts(EDITOR_SHORTCUTS, {
    save: { run: () => void save({ navigate: false }), disabled: saving },
    "save-view": { run: () => void save({ navigate: true }), disabled: saving },
    undo: { run: history.undo, disabled: !history.canUndo },
    redo: { run: history.redo, disabled: !history.canRedo },
    "new-panel": { run: () => addPanel(), disabled: sources.length === 0 },
    "duplicate-panel": {
      run: () => {
        if (selectedId) duplicate(selectedId);
      },
      disabled: selectedId === null,
    },
    run: {
      run: () => {
        // The SQL box binds Cmd+Enter to its own preview run; a second handler
        // firing on the same keystroke would apply an unrelated NL edit.
        if (document.activeElement?.id === "p-sql") return;
        runNlEdit();
      },
    },
    "focus-prompt": { run: () => document.getElementById("nl")?.focus() },
    dismiss: {
      run: discardProposal,
      // A dialog closes itself on Escape; dismissing the proposal underneath it
      // at the same time would be two actions from one keystroke.
      disabled: dialogOpen || proposal === null,
    },
    shortcuts: { run: () => setShowShortcuts((open) => !open) },
  });
  useShortcuts(bindings);

  const hint = (id: string) => {
    const binding = bindings.find((b) => b.id === id);
    return binding ? ` (${formatShortcut(binding, mac)})` : "";
  };

  // The finished generation once it lands, the partial object while it
  // streams — so the same diff fills in live instead of a JSON dump.
  const draft: PanelDraft | null =
    proposal?.panel ?? (proposal && isLoading ? ((object ?? {}) as PanelDraft) : null);
  const diff =
    proposal && proposalBase && draft
      ? diffPanels(proposalBase, draft, { streaming: proposal.panel === null })
      : null;

  const saveHint = hint("save");
  const saveViewHint = hint("save-view");

  const askAi = selected && (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="nl" className="mb-0">
          Describe a change
        </Label>
        <PromptHistoryMenu history={prompts} disabled={isLoading} onPick={setNlPrompt} />
      </div>
      {aiUnavailable && <AiUnavailable message={aiUnavailable} />}
      <form
        className="relative"
        onSubmit={(e) => {
          e.preventDefault();
          runNlEdit();
        }}
      >
        <Textarea
          id="nl"
          disabled={aiUnavailable !== null}
          rows={2}
          className="pr-14"
          placeholder="e.g. change to a bar chart grouped by status code"
          value={nlPrompt}
          onChange={(e) => setNlPrompt(e.target.value)}
        />
        <Button
          type="submit"
          size="icon"
          disabled={isLoading || !nlPrompt.trim() || aiUnavailable !== null}
          aria-label="Apply NL edit"
          title={`Apply NL edit${hint("run")}`}
          className="absolute bottom-4 right-2"
        >
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <SendHorizontal className="h-4 w-4" />
          )}
        </Button>
      </form>
      {model && !aiUnavailable && (
        <p className="text-xs text-muted">
          Runs <span className="text-foreground">{model}</span> once and shows the change
          to accept or reject.
        </p>
      )}
      <RepairingNote show={repairing} />
      {genError && (
        <ErrorDisplay
          error={apiErrorFromThrown(genError)}
          onRetry={runNlEdit}
          retryLabel="Try again"
          disabled={isLoading}
        />
      )}
      {diff && proposal && proposalBase && (
        <PanelDiffView
          diff={diff}
          model={model}
          streaming={proposal.panel === null}
          onAccept={acceptProposal}
          onReject={discardProposal}
          onRegenerate={(feedback) =>
            generatePanel(proposalBase, proposal.prompt, feedback)
          }
        />
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {/* The title reads as the page heading and edits in place. */}
          <h1 className="sr-only">Edit dashboard</h1>
          <input
            id="title"
            aria-label="Dashboard title"
            value={spec.title}
            maxLength={200}
            onChange={(e) =>
              updateSpec(
                { title: e.target.value },
                { action: "edit dashboard title", key: "spec:title" },
              )
            }
            className="w-full max-w-2xl truncate border-b border-transparent bg-transparent text-2xl font-semibold text-foreground transition-colors hover:border-border focus:border-primary focus:outline-none"
          />
          <p className="mt-0.5 text-xs text-muted">
            Editing · version {version}
            {dirty ? (
              <span className="text-warning"> &middot; unsaved changes</span>
            ) : (
              savedAt > 0 && now > 0 && <> &middot; saved {relativeTime(savedAt, now)}</>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center">
            <Button
              variant="ghost"
              size="icon"
              onClick={history.undo}
              disabled={!history.canUndo}
              aria-label="Undo"
              title={`Undo${history.undoAction ? ` ${history.undoAction}` : ""}${hint("undo")}`}
            >
              <Undo2 className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={history.redo}
              disabled={!history.canRedo}
              aria-label="Redo"
              title={`Redo${history.redoAction ? ` ${history.redoAction}` : ""}${hint("redo")}`}
            >
              <Redo2 className="h-4 w-4" />
            </Button>
            <Menu
              label="More editor actions"
              trigger={<MoreHorizontal className="h-4 w-4" />}
            >
              <MenuItem onClick={() => setShowShortcuts(true)}>
                <Keyboard className="h-4 w-4" /> Keyboard shortcuts
              </MenuItem>
              <MenuItem onClick={() => setShowDetails(true)}>
                <Info className="h-4 w-4" /> Description and tags…
              </MenuItem>
            </Menu>
          </div>
          <Menu
            label="Add panel"
            className={buttonClassName({
              variant: "secondary",
              className:
                "h-10 w-auto px-3 text-foreground hover:text-foreground data-[popup-open]:text-foreground",
            })}
            trigger={
              <>
                <Plus className="h-4 w-4" aria-hidden /> Add panel
              </>
            }
          >
            <MenuItem disabled={sources.length === 0} onClick={() => addPanel()}>
              <Plus className="h-4 w-4" /> Blank panel
            </MenuItem>
            <MenuItem
              disabled={sources.length === 0 || aiUnavailable !== null}
              onClick={() => addPanel(true)}
            >
              <Sparkles className="h-4 w-4" /> Describe it to the model
            </MenuItem>
            <MenuItem disabled={sources.length === 0} onClick={() => setPicking(true)}>
              <LayoutTemplate className="h-4 w-4" /> From a template…
            </MenuItem>
          </Menu>
          <Button
            variant="secondary"
            onClick={() => leave(`/dashboards/${dashboardId}`)}
            disabled={saving}
          >
            Close
          </Button>
          <Popover
            label="Save"
            align="end"
            panelClassName="w-80 max-w-[min(20rem,calc(100vw-2rem))] p-4 text-sm"
            className={buttonClassName({
              variant: "primary",
              className:
                "h-10 w-auto px-4 text-primary-foreground hover:bg-primary hover:text-primary-foreground data-[popup-open]:bg-primary data-[popup-open]:text-primary-foreground",
            })}
            trigger={
              <>
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Save className="h-4 w-4" aria-hidden />
                )}
                Save
              </>
            }
          >
            {(close) => (
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void save({ navigate: false }).then((ok) => ok && close());
                }}
              >
                <div>
                  <Label htmlFor="version-note">What changed? (optional)</Label>
                  <Input
                    id="version-note"
                    aria-label="Version note"
                    placeholder="e.g. Split errors by route"
                    maxLength={VERSION_NOTE_MAX}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={saving}
                    title={`Save and view${saveViewHint}`}
                    onClick={() => void save({ navigate: true })}
                  >
                    Save and view
                  </Button>
                  <Button
                    type="submit"
                    disabled={saving}
                    title={`Save a version and keep editing${saveHint}`}
                  >
                    Save version
                  </Button>
                </div>
              </form>
            )}
          </Popover>
        </div>
      </div>
      {error && (
        <ErrorDisplay
          error={error}
          onRetry={() => void save({ navigate: false })}
          retryLabel="Save again"
          disabled={saving}
        />
      )}

      <Notice open={offer.kind !== "none"}>
        {offer.kind !== "none" && (
          <DraftBanner
            offer={offer}
            now={now || offer.draft.savedAt}
            onRestore={restoreDraft}
            onDiscard={discardDraft}
          />
        )}
      </Notice>

      {missingSources.map((sourceId) => {
        const affected = panelsUsingSource(spec.panels, sourceId);
        return (
          <div
            key={sourceId}
            className="flex flex-wrap items-center justify-between gap-3 border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
          >
            <p className="flex items-start gap-2">
              <Unplug className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <span>
                {affected.length}{" "}
                {affected.length === 1 ? "panel points" : "panels point"} at{" "}
                <code>{sourceId}</code>, which is no longer available. This dashboard
                cannot be saved until {affected.length === 1 ? "it is" : "they are"}{" "}
                re-pointed at another source.
              </span>
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                setRepointing({ sourceId, panelIds: affected.map((p) => p.id) })
              }
            >
              Re-point {affected.length === 1 ? "panel" : `all ${affected.length}`}
            </Button>
          </div>
        );
      })}

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <section aria-label="Canvas" className="min-w-0">
          <PanelLayoutGrid
            panels={spec.panels}
            selectedId={selectedId}
            onSelect={selectPanel}
            onChange={setPanels}
            onDelete={removePanel}
            rowHeight={CANVAS_ROW_HEIGHT}
            empty={
              <div className="flex min-h-64 flex-col items-center justify-center gap-3 border border-dashed border-border p-8 text-center text-sm text-muted">
                <p>No panels yet.</p>
                <Button
                  variant="secondary"
                  onClick={() => addPanel()}
                  disabled={sources.length === 0}
                >
                  <Plus className="h-4 w-4" /> Add a panel
                </Button>
              </div>
            }
            renderBody={(panel) => (
              <div className="relative h-full">
                <PanelView
                  panel={panel}
                  state={canvas.states[panel.id]}
                  timeRange={panelTimeRange(panel, spec.timeRange)}
                />
                {panel.query && missingSources.includes(panel.query.sourceId) && (
                  <span className="absolute top-2 left-2 inline-flex items-center gap-1 border border-warning/40 bg-surface px-2 py-0.5 text-xs text-warning">
                    <Unplug className="h-3 w-3" aria-hidden /> Source removed
                  </span>
                )}
              </div>
            )}
          />
          {spec.panels.length > 0 && (
            <p className="mt-2 text-xs text-muted">
              Click a panel to edit it. Drag to move, drag the corner to resize; arrow
              keys move the focused panel, Shift and arrows resize it, Delete removes it.
            </p>
          )}
        </section>

        <aside
          aria-label={selected ? "Panel inspector" : "Dashboard settings"}
          className="min-w-0 border border-border bg-surface p-4 xl:sticky xl:top-20 xl:max-h-[calc(100vh-6rem)] xl:overflow-y-auto"
        >
          {selected ? (
            <PanelInspector
              // Remounting on selection drops the previous panel's preview
              // rather than showing it under a different panel.
              key={selected.id}
              panel={selected}
              sources={sources}
              timeRange={spec.timeRange}
              refreshIntervalMs={spec.refreshIntervalMs}
              variables={previewValues.values}
              sourceMissing={
                selected.query !== undefined &&
                missingSources.includes(selected.query.sourceId)
              }
              ai={askAi}
              onRepoint={() => {
                if (!selected.query) return;
                setRepointing({
                  sourceId: selected.query.sourceId,
                  panelIds: [selected.id],
                });
              }}
              onChange={(fn, intent) => updatePanel(selected.id, fn, intent)}
              onClose={() => selectPanel(null)}
              onDuplicate={() => duplicate(selected.id)}
              onSaveAsTemplate={panelTemplate.openDialog}
              onDelete={() => removePanel(selected.id)}
            />
          ) : (
            <DashboardSettings
              spec={spec}
              sources={sources}
              details={details}
              variablesError={previewValues.error}
              onChange={updateSpec}
              onArrange={arrangeColumns}
              onEditDetails={() => setShowDetails(true)}
            />
          )}
        </aside>
      </div>

      {panelTemplate.dialog}

      {picking && (
        <TemplatePicker
          workspaceId={workspaceId}
          sources={sources.map((s) => ({ id: s.id, name: s.name }))}
          defaultSourceId={selected?.query?.sourceId}
          applyLabel="Add panels"
          onApply={applyTemplate}
          onClose={() => setPicking(false)}
        />
      )}

      {repointing && repointPanelSet.length > 0 && (
        <RepointPanelsDialog
          deadSourceId={repointing.sourceId}
          panels={repointPanelSet}
          sources={sources}
          variables={[...declaredVariables(spec)]}
          onApply={applyRepoint}
          onClose={() => setRepointing(null)}
        />
      )}

      <Dialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
        title="Delete this panel?"
        className="max-w-md"
      >
        <div className="space-y-4">
          <p className="text-sm text-muted">
            <span className="text-foreground">{confirmDelete?.title}</span> has{" "}
            {confirmDelete?.query ? "a query" : "text"} of its own. Deleting it is one
            undo away, and nothing is written until you save.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (confirmDelete) deletePanel(confirmDelete.id);
              }}
            >
              Delete panel
            </Button>
          </div>
        </div>
      </Dialog>

      <ShortcutsDialog open={showShortcuts} onOpenChange={setShowShortcuts} />

      {/*
        No `allowRename`: the title is a spec field, edited in the header and
        saved with the version. Offering a second, immediately applied rename
        here would be two names for the same thing.
      */}
      <DashboardDetailsDialog
        dashboardId={dashboardId}
        initial={{ title: spec.title, ...details }}
        suggestions={tagSuggestions}
        allowRename={false}
        open={showDetails}
        onOpenChange={setShowDetails}
        onSaved={(next) => setDetails({ description: next.description, tags: next.tags })}
      />

      <LeaveGuardDialog
        open={pendingHref !== null}
        saving={saving}
        onCancel={() => setPendingHref(null)}
        onDiscard={() => {
          if (pendingHref) leaveNow(pendingHref);
        }}
        onSave={() => {
          const href = pendingHref;
          void save({ navigate: false }).then((ok) => {
            if (ok && href) {
              setPendingHref(null);
              router.push(href);
            }
          });
        }}
      />
    </div>
  );
}
