"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { experimental_useObject as useObject } from "@ai-sdk/react";
import {
  Plus,
  Trash2,
  Save,
  SendHorizontal,
  Loader2,
  LayoutGrid,
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
import { clampLayout } from "@/lib/grid-layout";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PreviewDashboard } from "@/components/dashboard/PreviewDashboard";
import { PanelLayoutGrid } from "@/components/dashboard/PanelLayoutGrid";
import { SqlEditor } from "@/components/sql/SqlEditor";
import { TimeFieldPicker } from "@/components/sql/TimeFieldPicker";
import type { SourceCatalog } from "@/lib/registry";
import { PanelPreview, usePanelPreview } from "@/components/dashboard/PanelPreview";
import { PanelDiffView } from "@/components/dashboard/PanelDiffView";
import { acceptedPanel, diffPanels, type PanelDraft } from "@/lib/panel-diff";
import { missingSourceIds, panelsUsingSource, repointPanels } from "@/lib/panel-repoint";
import { RepointPanelsDialog } from "@/components/dashboard/RepointPanelsDialog";
import { ErrorDisplay } from "@/components/ui/error-display";
import { type ApiError, apiErrorFromThrown, readApiError } from "@/lib/errors";

interface SourceOption {
  id: string;
  name: string;
  workspaceId: string;
  /** Tables and columns, for completion and the editor's allowlist hint. */
  catalog: SourceCatalog;
}

const VIZ_OPTIONS = VizType.options.map((v) => ({ value: v, label: v }));
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
  initialSpec,
  initialPanelId,
  sources,
}: {
  dashboardId: string;
  initialSpec: Dashboard;
  /** Panel to open selected; ignored when it is not in the spec. */
  initialPanelId?: string;
  version: number;
  sources: SourceOption[];
}) {
  const router = useRouter();
  const [spec, setSpec] = React.useState<Dashboard>(initialSpec);
  const [selectedId, setSelectedId] = React.useState<string | null>(
    initialSpec.panels.find((p) => p.id === initialPanelId)?.id ??
      initialSpec.panels[0]?.id ??
      null,
  );
  const [activeTab, setActiveTab] = React.useState<"editor" | "preview">("editor");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [nlPrompt, setNlPrompt] = React.useState("");
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

  function updateSpec(patch: Partial<Dashboard>) {
    setSpec((s) => ({ ...s, ...patch }));
  }

  function arrangeColumns(columns: number) {
    setSpec((s) => ({ ...s, panels: autoLayoutPanels(s.panels, columns) }));
  }

  /** One drag, resize or nudge from the arranger: one change to the spec. */
  function setPanels(panels: Panel[]) {
    setSpec((s) => ({ ...s, panels }));
  }

  function updatePanel(id: string, fn: (p: Panel) => Panel) {
    setSpec((s) => ({
      ...s,
      panels: s.panels.map((p) => (p.id === id ? fn(p) : p)),
    }));
  }

  function addPanel() {
    if (sources.length === 0) return;
    const id = `panel-${Date.now().toString(36)}`;
    const maxY = spec.panels.reduce((m, p) => Math.max(m, p.layout.y + p.layout.h), 0);
    const panel: Panel = {
      id,
      title: "New panel",
      viz: "line",
      query: { sourceId: sources[0].id, sql: "SELECT 1 AS value", timeField: undefined },
      layout: { x: 0, y: maxY, w: 6, h: 4 },
    };
    setSpec((s) => ({ ...s, panels: [...s.panels, panel] }));
    setSelectedId(id);
  }

  function removePanel(id: string) {
    setSpec((s) => ({ ...s, panels: s.panels.filter((p) => p.id !== id) }));
    if (proposal?.panelId === id) discardProposal();
    if (selectedId === id) setSelectedId(spec.panels[0]?.id ?? null);
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
    if (!selected || !nlPrompt.trim()) return;
    generatePanel(selected, nlPrompt);
  }

  function acceptProposal() {
    const generated = proposal?.panel;
    if (!generated || !proposalBase) return;
    // One setSpec, so accepting is one step for undo/redo (#81) rather than a
    // field-by-field trail.
    updatePanel(proposalBase.id, () => acceptedPanel(proposalBase, generated));
    setProposal(null);
    setNlPrompt("");
  }

  /**
   * Move the reviewed panels onto their new source. One `setSpec`, so a bulk
   * re-point is one step to undo (#81) rather than one per panel — and nothing
   * is written here: the change is saved by the existing Save version, which
   * appends a version and re-validates every statement server-side.
   */
  function applyRepoint(input: { sourceId: string; panelIds: string[] }) {
    setSpec((s) => ({ ...s, panels: repointPanels(s.panels, input) }));
    setRepointing(null);
  }

  async function save() {
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
      return;
    }
    const res = await fetch(`/api/dashboards/${dashboardId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: parsed.data }),
    });
    setSaving(false);
    if (!res.ok) {
      setError(await readApiError(res));
      return;
    }
    router.push(`/dashboards/${dashboardId}`);
  }

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
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Edit dashboard</h1>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => router.push(`/dashboards/${dashboardId}`)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
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
          onRetry={save}
          retryLabel="Save again"
          disabled={saving}
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
                  onChange={(e) => updateSpec({ title: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="refresh">Refresh (ms)</Label>
                <Input
                  id="refresh"
                  type="number"
                  value={spec.refreshIntervalMs}
                  onChange={(e) =>
                    updateSpec({ refreshIntervalMs: Number(e.target.value) })
                  }
                />
              </div>
              <div>
                <Label htmlFor="from">Time from</Label>
                <Input
                  id="from"
                  value={spec.timeRange.from}
                  onChange={(e) =>
                    updateSpec({ timeRange: { ...spec.timeRange, from: e.target.value } })
                  }
                />
              </div>
              <div>
                <Label htmlFor="to">Time to</Label>
                <Input
                  id="to"
                  value={spec.timeRange.to}
                  onChange={(e) =>
                    updateSpec({ timeRange: { ...spec.timeRange, to: e.target.value } })
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
                <Button variant="secondary" size="sm" onClick={addPanel}>
                  <Plus className="h-4 w-4" /> Add
                </Button>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1">
                  {spec.panels.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => selectPanel(p.id)}
                      className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm ${
                        p.id === selectedId ? "bg-surface-2" : "hover:bg-surface-2"
                      }`}
                    >
                      <span className="truncate">{p.title}</span>
                      <Trash2
                        className="h-4 w-4 shrink-0 text-muted hover:text-danger"
                        onClick={(e) => {
                          e.stopPropagation();
                          removePanel(p.id);
                        }}
                      />
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>{selected ? "Panel editor" : "No panel selected"}</CardTitle>
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
                    onChange={(fn) => updatePanel(selected.id, fn)}
                  />
                )}
                {selected && (
                  <div className="space-y-2 border-t border-border pt-4">
                    <Label htmlFor="nl">
                      Natural-language edit (runs the model once)
                    </Label>
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
                        title="Apply NL edit"
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

      {repointing && repointPanelSet.length > 0 && (
        <RepointPanelsDialog
          deadSourceId={repointing.sourceId}
          panels={repointPanelSet}
          sources={sources}
          onApply={applyRepoint}
          onClose={() => setRepointing(null)}
        />
      )}
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
  onChange: (fn: (p: Panel) => Panel) => void;
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
            onChange={(e) => onChange((p) => ({ ...p, title: e.target.value }))}
          />
        </div>
        <div>
          <Label>Source</Label>
          <Select
            value={panel.query.sourceId}
            onValueChange={(v) =>
              onChange((p) => ({ ...p, query: { ...p.query, sourceId: v } }))
            }
            options={sourceOptions}
          />
        </div>
        <div>
          <Label>Visualization</Label>
          <Select
            value={panel.viz}
            onValueChange={(v) => onChange((p) => ({ ...p, viz: v as Panel["viz"] }))}
            options={VIZ_OPTIONS}
          />
        </div>
        <div>
          <Label>Format</Label>
          <Select
            value={panel.format ?? ""}
            onValueChange={(v) =>
              onChange((p) => ({ ...p, format: v ? (v as Panel["format"]) : undefined }))
            }
            options={FORMAT_OPTIONS}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="p-sql">
          SQL (SELECT only; no time filter — the server injects it)
        </Label>
        <SqlEditor
          id="p-sql"
          value={panel.query.sql}
          catalog={catalog}
          onChange={(sql) => onChange((p) => ({ ...p, query: { ...p.query, sql } }))}
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
            onChange((p) => ({
              ...p,
              layout: clampLayout({ ...p.layout, w: Number(v) }),
            }))
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
          onChange((p) => ({ ...p, query: { ...p.query, timeField } }))
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
                onChange((p) => ({
                  ...p,
                  layout: clampLayout({ ...p.layout, [k]: Number(e.target.value) }),
                }))
              }
            />
          </div>
        ))}
      </div>
    </div>
  );
}
