"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { experimental_useObject as useObject } from "@ai-sdk/react";
import {
  Plus,
  Save,
  SendHorizontal,
  Loader2,
  LayoutGrid,
  LayoutTemplate,
  Info,
  Keyboard,
  Sparkles,
  Redo2,
  Undo2,
  Unplug,
} from "lucide-react";
import {
  type Dashboard,
  Panel,
  VizType,
  ValueFormat,
  safeParseDashboard,
} from "@/lib/ir";
import { autoLayoutPanels, COLUMN_PRESETS } from "@/lib/layout";
import {
  canMove,
  duplicatePanel,
  movePanel,
  type PanelMove,
  reorderPanels,
} from "@/lib/panel-list";
import { isStarterSql, starterPanel } from "@/lib/panel-starter";
import { clampLayout } from "@/lib/grid-layout";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PreviewDashboard } from "@/components/dashboard/PreviewDashboard";
import { PanelLayoutGrid } from "@/components/dashboard/PanelLayoutGrid";
import { PanelList } from "@/components/dashboard/PanelList";
import { SqlEditor } from "@/components/sql/SqlEditor";
import { TimeFieldPicker } from "@/components/sql/TimeFieldPicker";
import type { SourceCatalog } from "@/lib/registry";
import { PanelPreview, usePanelPreview } from "@/components/dashboard/PanelPreview";
import { PanelDiffView } from "@/components/dashboard/PanelDiffView";
import { PromptHistoryMenu, usePromptHistory } from "@/components/prompt-history";
import { acceptedPanel, diffPanels, type PanelDraft } from "@/lib/panel-diff";
import { missingSourceIds, panelsUsingSource, repointPanels } from "@/lib/panel-repoint";
import { RepointPanelsDialog } from "@/components/dashboard/RepointPanelsDialog";
import { ErrorDisplay } from "@/components/ui/error-display";
import { type ApiError, apiErrorFromThrown, readApiError } from "@/lib/errors";
import { appendTemplate, type Template } from "@/lib/templates";
import { SaveAsTemplate } from "@/components/templates/SaveAsTemplate";
import { TemplatePicker } from "@/components/templates/TemplatePicker";
import { DraftBanner } from "@/components/editor/DraftBanner";
import { Dialog } from "@/components/ui/dialog";
import { LeaveGuardDialog } from "@/components/editor/LeaveGuardDialog";
import { ShortcutsDialog } from "@/components/editor/ShortcutsDialog";
import { DashboardDetailsDialog } from "@/components/dashboard/DashboardDetailsDialog";
import { useHistory } from "@/lib/editor/use-history";
import {
  type Binding,
  formatShortcut,
  useIsMac,
  useShortcuts,
} from "@/lib/editor/use-shortcuts";
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

interface SourceOption {
  id: string;
  name: string;
  workspaceId: string;
  /** Tables and columns, for completion and the editor's allowlist hint. */
  catalog: SourceCatalog;
}

/** How a spec change is recorded in the undo stack. */
interface EditIntent {
  action: string;
  /** Consecutive edits sharing a key coalesce into one history entry. */
  key?: string | null;
}

const VIZ_OPTIONS = VizType.options.map((v) => ({ value: v, label: v }));
/** `Panel.description` is `z.string().max(500)`; the box stops at the same place. */
const PANEL_DESCRIPTION_MAX = 500;
const WIDTH_PRESETS = [
  { value: "12", label: "Full width" },
  { value: "6", label: "Half (2-up)" },
  { value: "4", label: "Third (3-up)" },
  { value: "3", label: "Quarter (4-up)" },
];
const FORMAT_OPTIONS = [
  { value: "", label: "none" },
  ...ValueFormat.options.map((f) => ({ value: f, label: f })),
];

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
}) {
  const router = useRouter();
  const mac = useIsMac();
  // Every spec mutation goes through `history.set`, which is what makes an
  // accidental delete or a mistaken Arrange recoverable (#81).
  const history = useHistory<Dashboard>(initialSpec);
  const spec = history.state;

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

  const [selectedId, setSelectedId] = React.useState<string | null>(
    initialSpec.panels.find((p) => p.id === initialPanelId)?.id ??
      initialSpec.panels[0]?.id ??
      null,
  );
  const [activeTab, setActiveTab] = React.useState<"editor" | "preview">("editor");
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
    ? spec.panels.filter((p) => repointing.panelIds.includes(p.id))
    : [];
  const proposalBase = proposal
    ? (spec.panels.find((p) => p.id === proposal.panelId) ?? null)
    : null;

  const {
    object,
    submit,
    stop,
    isLoading,
    error: genError,
  } = useObject({
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
    setSelectedId(offer.draft.spec.panels[0]?.id ?? null);
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

  function move(id: string, to: PanelMove) {
    if (!canMove(spec.panels, id, to)) return;
    history.set((s) => ({ ...s, panels: movePanel(s.panels, id, to) }), {
      action: `move panel ${to}`,
    });
  }

  function reorder(id: string, to: number) {
    history.set((s) => ({ ...s, panels: reorderPanels(s.panels, id, to) }), {
      action: "reorder panels",
    });
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
    // Select what is LEFT: falling back to `panels[0]` selected the panel that
    // was just removed whenever it happened to be the first one.
    if (selectedId === id) {
      setSelectedId(spec.panels.find((p) => p.id !== id)?.id ?? null);
    }
  }

  /** Drop the proposal, cancelling the run behind it if one is still going. */
  function discardProposal() {
    if (isLoading) stop();
    setProposal(null);
  }

  function selectPanel(id: string) {
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
    const instruction = feedback.trim()
      ? `${prompt}\n\nAdditional feedback: ${feedback.trim()}`.slice(0, 4000)
      : prompt;
    setProposal({ panelId: base.id, prompt, panel: null });
    submit({
      mode: "panel",
      sourceId: base.query.sourceId,
      prompt: instruction,
      current: base,
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
  const bindings: Binding[] = [
    {
      id: "save",
      key: "s",
      mod: true,
      inTextField: true,
      group: "Saving",
      description: "Save a version and keep editing",
      run: () => void save({ navigate: false }),
      disabled: saving,
    },
    {
      id: "save-view",
      key: "s",
      mod: true,
      shift: true,
      inTextField: true,
      group: "Saving",
      description: "Save and view the dashboard",
      run: () => void save({ navigate: true }),
      disabled: saving,
    },
    {
      id: "undo",
      key: "z",
      mod: true,
      group: "Editing",
      description: "Undo",
      run: history.undo,
      disabled: !history.canUndo,
    },
    {
      id: "redo",
      key: "z",
      mod: true,
      shift: true,
      group: "Editing",
      description: "Redo",
      run: history.redo,
      disabled: !history.canRedo,
    },
    {
      id: "new-panel",
      key: "n",
      group: "Editing",
      description: "Add a panel",
      run: () => addPanel(),
      disabled: sources.length === 0,
    },
    {
      id: "duplicate-panel",
      key: "d",
      group: "Editing",
      description: "Duplicate the selected panel",
      run: () => {
        if (selectedId) duplicate(selectedId);
      },
      disabled: selectedId === null,
    },
    {
      id: "run",
      key: "Enter",
      mod: true,
      inTextField: true,
      group: "Editing",
      description: "Apply the natural-language edit (run the preview in the SQL box)",
      run: () => {
        // The SQL box binds Cmd+Enter to its own preview run; a second handler
        // firing on the same keystroke would apply an unrelated NL edit.
        if (document.activeElement?.id === "p-sql") return;
        runNlEdit();
      },
    },
    {
      id: "focus-prompt",
      key: "/",
      group: "Editing",
      description: "Focus the natural-language prompt",
      run: () => document.getElementById("nl")?.focus(),
    },
    {
      id: "dismiss",
      key: "Escape",
      group: "Editing",
      description: "Dismiss the generated panel under review",
      run: discardProposal,
      // A dialog closes itself on Escape; dismissing the proposal underneath it
      // at the same time would be two actions from one keystroke.
      disabled: dialogOpen || proposal === null,
    },
    {
      id: "shortcuts",
      key: "?",
      anyShift: true,
      group: "Help",
      description: "Show this list",
      run: () => setShowShortcuts((open) => !open),
    },
  ];
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Edit dashboard</h1>
          <p className="mt-0.5 text-xs text-muted">
            Version {version}
            {dirty ? (
              <span className="text-warning"> &middot; unsaved changes</span>
            ) : (
              savedAt > 0 && now > 0 && <> &middot; saved {relativeTime(savedAt, now)}</>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
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
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setShowShortcuts(true)}
              aria-label="Keyboard shortcuts"
              title={`Keyboard shortcuts${hint("shortcuts")}`}
            >
              <Keyboard className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setShowDetails(true)}
              aria-label="Dashboard details"
              title="Description and tags (saved separately from the spec)"
            >
              <Info className="h-4 w-4" />
            </Button>
          </div>
          <Input
            aria-label="Version note"
            placeholder="What changed? (optional)"
            className="w-56"
            maxLength={VERSION_NOTE_MAX}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <Button
            variant="secondary"
            onClick={() => leave(`/dashboards/${dashboardId}`)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            variant="secondary"
            onClick={() => void save({ navigate: true })}
            disabled={saving}
            title={`Save and view${hint("save-view")}`}
          >
            Save &amp; view
          </Button>
          <Button
            onClick={() => void save({ navigate: false })}
            disabled={saving}
            title={`Save a version and keep editing${hint("save")}`}
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save version
          </Button>
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

      {offer.kind !== "none" && (
        <DraftBanner
          offer={offer}
          now={now || offer.draft.savedAt}
          onRestore={restoreDraft}
          onDiscard={discardDraft}
        />
      )}

      {missingSources.map((sourceId) => {
        const affected = panelsUsingSource(spec.panels, sourceId);
        return (
          <div
            key={sourceId}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
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

      <div
        className="flex w-fit rounded-lg border border-border bg-surface p-1"
        role="tablist"
        aria-label="Dashboard workspace"
      >
        {(["editor", "preview"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            aria-controls={`edit-dashboard-${tab}-panel`}
            id={`edit-dashboard-${tab}-tab`}
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

      {activeTab === "editor" ? (
        <>
          <Card
            role="tabpanel"
            id="edit-dashboard-editor-panel"
            aria-labelledby="edit-dashboard-editor-tab"
          >
            <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-4">
              <div>
                <Label htmlFor="title">Title</Label>
                <Input
                  id="title"
                  value={spec.title}
                  onChange={(e) =>
                    updateSpec(
                      { title: e.target.value },
                      { action: "edit dashboard title", key: "spec:title" },
                    )
                  }
                />
              </div>
              <div>
                <Label htmlFor="refresh">Refresh (ms)</Label>
                <Input
                  id="refresh"
                  type="number"
                  value={spec.refreshIntervalMs}
                  onChange={(e) =>
                    updateSpec(
                      { refreshIntervalMs: Number(e.target.value) },
                      { action: "change refresh interval", key: "spec:refresh" },
                    )
                  }
                />
              </div>
              <div>
                <Label htmlFor="from">Time from</Label>
                <Input
                  id="from"
                  value={spec.timeRange.from}
                  onChange={(e) =>
                    updateSpec(
                      { timeRange: { ...spec.timeRange, from: e.target.value } },
                      { action: "change time range", key: "spec:from" },
                    )
                  }
                />
              </div>
              <div>
                <Label htmlFor="to">Time to</Label>
                <Input
                  id="to"
                  value={spec.timeRange.to}
                  onChange={(e) =>
                    updateSpec(
                      { timeRange: { ...spec.timeRange, to: e.target.value } },
                      { action: "change time range", key: "spec:to" },
                    )
                  }
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Layout</CardTitle>
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <LayoutGrid className="h-3.5 w-3.5 text-muted" />
                <span className="mr-1 text-muted">Arrange:</span>
                {COLUMN_PRESETS.map((n) => (
                  <Button
                    key={n}
                    variant="secondary"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => arrangeColumns(n)}
                  >
                    {n}-up
                  </Button>
                ))}
              </div>
            </CardHeader>
            <CardContent>
              <p className="mb-3 text-xs text-muted">
                Drag a panel to move it, drag its corner to resize. Arrow keys move the
                focused panel; hold Shift to resize.
              </p>
              <PanelLayoutGrid
                panels={spec.panels}
                selectedId={selectedId}
                onSelect={selectPanel}
                onChange={setPanels}
              />
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-1">
              <CardHeader>
                <CardTitle>Panels</CardTitle>
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setPicking(true)}
                    disabled={sources.length === 0}
                  >
                    <LayoutTemplate className="h-4 w-4" /> From template
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => addPanel(true)}
                    disabled={sources.length === 0}
                    title="Add a panel and describe it to the model"
                  >
                    <Sparkles className="h-4 w-4" /> Describe
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => addPanel()}
                    disabled={sources.length === 0}
                    title={`Add a panel${hint("new-panel")}`}
                  >
                    <Plus className="h-4 w-4" /> Add
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <PanelList
                  panels={spec.panels}
                  selectedId={selectedId}
                  onSelect={selectPanel}
                  onMove={move}
                  onReorder={reorder}
                  onDuplicate={duplicate}
                  onDelete={removePanel}
                />
                {spec.panels.length > 1 && (
                  <p className="text-xs text-muted">
                    Reordering changes the list only. Use Arrange above to flow the new
                    order onto the grid.
                  </p>
                )}
              </CardContent>
            </Card>

            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>{selected ? "Panel editor" : "No panel selected"}</CardTitle>
                {selected && (
                  <SaveAsTemplate
                    // Keyed on the panel so the dialog's defaults follow the
                    // selection instead of keeping the last panel's name.
                    key={selected.id}
                    workspaceId={workspaceId}
                    defaultName={selected.title}
                    subject={{ kind: "panel", panel: selected }}
                  />
                )}
              </CardHeader>
              <CardContent className="space-y-4">
                {selected && (
                  <PanelEditor
                    // Remounting on selection drops the previous panel's
                    // preview rather than showing it under a different panel.
                    key={selected.id}
                    panel={selected}
                    sources={sources}
                    timeRange={spec.timeRange}
                    sourceMissing={missingSources.includes(selected.query.sourceId)}
                    onRepoint={() =>
                      setRepointing({
                        sourceId: selected.query.sourceId,
                        panelIds: [selected.id],
                      })
                    }
                    onChange={(fn, intent) => updatePanel(selected.id, fn, intent)}
                  />
                )}
                {selected && (
                  <div className="space-y-2 border-t border-border pt-4">
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor="nl" className="mb-0">
                        Natural-language edit (runs the model once)
                      </Label>
                      <PromptHistoryMenu
                        history={prompts}
                        disabled={isLoading}
                        onPick={setNlPrompt}
                      />
                    </div>
                    <div className="relative">
                      <Textarea
                        id="nl"
                        rows={2}
                        className="pr-14"
                        placeholder="e.g. change to a bar chart grouped by status code"
                        value={nlPrompt}
                        onChange={(e) => setNlPrompt(e.target.value)}
                      />
                      <Button
                        size="icon"
                        onClick={runNlEdit}
                        disabled={isLoading || !nlPrompt.trim()}
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
                    </div>
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
                )}
              </CardContent>
            </Card>
          </div>
        </>
      ) : (
        <section
          role="tabpanel"
          id="edit-dashboard-preview-panel"
          aria-labelledby="edit-dashboard-preview-tab"
        >
          <PreviewDashboard spec={spec} />
        </section>
      )}

      {picking && (
        <TemplatePicker
          workspaceId={workspaceId}
          sources={sources.map((s) => ({ id: s.id, name: s.name }))}
          defaultSourceId={selected?.query.sourceId}
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
            <span className="text-foreground">{confirmDelete?.title}</span> has a query of
            its own. Deleting it is one undo away, and nothing is written until you save.
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

      <ShortcutsDialog
        shortcuts={bindings}
        open={showShortcuts}
        onOpenChange={setShowShortcuts}
      />

      {/*
        No `allowRename`: the title is a spec field, edited in the settings
        card above and saved with the version. Offering a second, immediately
        applied rename here would be two names for the same thing.
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

function PanelEditor({
  panel,
  sources,
  timeRange,
  sourceMissing,
  onRepoint,
  onChange,
}: {
  panel: Panel;
  sources: SourceOption[];
  timeRange: Dashboard["timeRange"];
  /** This panel's source is not among the workspace's live sources. */
  sourceMissing: boolean;
  onRepoint: () => void;
  /** Each control names its own undo step, so a burst of typing is one entry. */
  onChange: (fn: (p: Panel) => Panel, intent: EditIntent) => void;
}) {
  const preview = usePanelPreview(panel, timeRange);
  const catalog = sources.find((s) => s.id === panel.query.sourceId)?.catalog ?? null;
  // A removed source is still what the panel names, so it stays in the list
  // rather than making the control read as some other source's panel.
  const sourceOptions = sources.map((s) => ({ value: s.id, label: s.name }));
  if (sourceMissing) {
    sourceOptions.unshift({
      value: panel.query.sourceId,
      label: `${panel.query.sourceId} (removed)`,
    });
  }

  return (
    <div className="space-y-3">
      {sourceMissing && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          <span>This panel&rsquo;s data source has been removed.</span>
          <Button variant="secondary" size="sm" onClick={onRepoint}>
            Re-point to another source
          </Button>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="p-title">Title</Label>
          <Input
            id="p-title"
            value={panel.title}
            onChange={(e) =>
              onChange((p) => ({ ...p, title: e.target.value }), {
                action: "edit panel title",
                key: `${panel.id}:title`,
              })
            }
          />
        </div>
        <div>
          <Label>Source</Label>
          <Select
            value={panel.query.sourceId}
            onValueChange={(v) =>
              onChange((p) => ({ ...p, query: { ...p.query, sourceId: v } }), {
                action: "change panel source",
              })
            }
            options={sourceOptions}
          />
        </div>
        <div>
          <Label>Visualization</Label>
          <Select
            value={panel.viz}
            onValueChange={(v) =>
              onChange((p) => ({ ...p, viz: v as Panel["viz"] }), {
                action: "change visualization",
              })
            }
            options={VIZ_OPTIONS}
          />
        </div>
        <div>
          <Label>Format</Label>
          <Select
            value={panel.format ?? ""}
            onValueChange={(v) =>
              onChange(
                (p) => ({ ...p, format: v ? (v as Panel["format"]) : undefined }),
                { action: "change value format" },
              )
            }
            options={FORMAT_OPTIONS}
          />
        </div>
      </div>

      <div>
        <Label htmlFor="p-description">Description (what this panel computes)</Label>
        <Textarea
          id="p-description"
          rows={2}
          maxLength={PANEL_DESCRIPTION_MAX}
          placeholder="e.g. Requests per minute, grouped by route"
          value={panel.description ?? ""}
          onChange={(e) =>
            onChange((p) => ({ ...p, description: e.target.value || undefined }), {
              action: "edit panel description",
              key: `${panel.id}:description`,
            })
          }
        />
        <p className="mt-1 text-xs text-muted">
          Shown to readers behind the info icon on the panel. The model writes one for
          every panel it generates; this is where you correct it.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="p-sql">
          SQL (SELECT only; no time filter — the server injects it)
        </Label>
        <SqlEditor
          id="p-sql"
          value={panel.query.sql}
          catalog={catalog}
          onChange={(sql) =>
            onChange((p) => ({ ...p, query: { ...p.query, sql } }), {
              action: "edit SQL",
              key: `${panel.id}:sql`,
            })
          }
          onRun={() => {
            if (preview.busy === null) preview.run();
          }}
          placeholder="SELECT …"
        />
        <PanelPreview panel={panel} preview={preview} />
      </div>

      <div>
        <Label>Width</Label>
        <Select
          value={String(panel.layout.w)}
          onValueChange={(v) =>
            onChange(
              (p) => ({ ...p, layout: clampLayout({ ...p.layout, w: Number(v) }) }),
              { action: "change panel width" },
            )
          }
          options={
            WIDTH_PRESETS.some((o) => o.value === String(panel.layout.w))
              ? WIDTH_PRESETS
              : [
                  ...WIDTH_PRESETS,
                  {
                    value: String(panel.layout.w),
                    label: `Custom (${panel.layout.w}/12)`,
                  },
                ]
          }
        />
        <p className="mt-1 text-xs text-muted">
          Column span on the 12-col grid. Fine-tune exact position below.
        </p>
      </div>

      <TimeFieldPicker
        id="p-tf"
        value={panel.query.timeField}
        sql={panel.query.sql}
        catalog={catalog}
        onChange={(timeField) =>
          onChange((p) => ({ ...p, query: { ...p.query, timeField } }), {
            action: "change time field",
          })
        }
      />

      <div className="grid grid-cols-4 gap-2">
        {(["x", "y", "w", "h"] as const).map((k) => (
          <div key={k}>
            <Label htmlFor={`p-${k}`}>{k}</Label>
            <Input
              id={`p-${k}`}
              type="number"
              value={panel.layout[k]}
              onChange={(e) =>
                onChange(
                  (p) => ({
                    ...p,
                    layout: clampLayout({ ...p.layout, [k]: Number(e.target.value) }),
                  }),
                  { action: "edit panel position", key: `${panel.id}:layout` },
                )
              }
            />
          </div>
        ))}
      </div>
    </div>
  );
}
