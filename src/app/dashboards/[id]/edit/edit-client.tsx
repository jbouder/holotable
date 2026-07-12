"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { experimental_useObject as useObject } from "@ai-sdk/react";
import { Plus, Trash2, Save, SendHorizontal, Loader2, LayoutGrid } from "lucide-react";
import { Dashboard, Panel, VizType, ValueFormat, safeParseDashboard } from "@/lib/ir";
import { autoLayoutPanels, COLUMN_PRESETS } from "@/lib/layout";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PreviewDashboard } from "@/components/dashboard/PreviewDashboard";
import { RetryNotice } from "@/components/dashboard/RetryNotice";

interface SourceOption {
  id: string;
  name: string;
  workspaceId: string;
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
  sources,
}: {
  dashboardId: string;
  initialSpec: Dashboard;
  version: number;
  sources: SourceOption[];
}) {
  const router = useRouter();
  const [spec, setSpec] = React.useState<Dashboard>(initialSpec);
  const [selectedId, setSelectedId] = React.useState<string | null>(
    initialSpec.panels[0]?.id ?? null,
  );
  const [activeTab, setActiveTab] = React.useState<"editor" | "preview">("editor");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [nlPrompt, setNlPrompt] = React.useState("");

  const selected = spec.panels.find((p) => p.id === selectedId) ?? null;

  const { object, submit, isLoading, error: genError } = useObject({
    api: "/api/generate",
    schema: Panel,
    onFinish({ object }) {
      if (object) updatePanel(object.id, () => object);
    },
  });

  const showStreaming = isLoading || object !== undefined;

  function updateSpec(patch: Partial<Dashboard>) {
    setSpec((s) => ({ ...s, ...patch }));
  }

  function arrangeColumns(columns: number) {
    setSpec((s) => ({ ...s, panels: autoLayoutPanels(s.panels, columns) }));
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
    if (selectedId === id) setSelectedId(spec.panels[0]?.id ?? null);
  }

  function runNlEdit() {
    if (!selected || !nlPrompt.trim()) return;
    submit({ mode: "panel", sourceId: selected.query.sourceId, prompt: nlPrompt, current: selected });
  }

  async function save() {
    setSaving(true);
    setError(null);
    const parsed = safeParseDashboard(spec);
    if (!parsed.success) {
      setError(`invalid spec: ${parsed.error.issues[0]?.message}`);
      setSaving(false);
      return;
    }
    const res = await fetch(`/api/dashboards/${dashboardId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: parsed.data }),
    });
    const body = await res.json();
    setSaving(false);
    if (!res.ok) {
      setError(body.error ?? "save failed");
      return;
    }
    router.push(`/dashboards/${dashboardId}`);
  }

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
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save version
          </Button>
        </div>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}

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
                <Input id="title" value={spec.title} onChange={(e) => updateSpec({ title: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="refresh">Refresh (ms)</Label>
                <Input
                  id="refresh"
                  type="number"
                  value={spec.refreshIntervalMs}
                  onChange={(e) => updateSpec({ refreshIntervalMs: Number(e.target.value) })}
                />
              </div>
              <div>
                <Label htmlFor="from">Time from</Label>
                <Input
                  id="from"
                  value={spec.timeRange.from}
                  onChange={(e) => updateSpec({ timeRange: { ...spec.timeRange, from: e.target.value } })}
                />
              </div>
              <div>
                <Label htmlFor="to">Time to</Label>
                <Input
                  id="to"
                  value={spec.timeRange.to}
                  onChange={(e) => updateSpec({ timeRange: { ...spec.timeRange, to: e.target.value } })}
                />
              </div>
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
            <div className="flex flex-wrap items-center gap-1.5 border-b border-border pb-3 text-xs">
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
            <div className="space-y-1">
            {spec.panels.map((p) => (
              <button
                key={p.id}
                onClick={() => setSelectedId(p.id)}
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
                panel={selected}
                sources={sources}
                onChange={(fn) => updatePanel(selected.id, fn)}
              />
            )}
            {selected && (
              <div className="space-y-2 border-t border-border pt-4">
                <Label htmlFor="nl">Natural-language edit (runs the model once)</Label>
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
                  <RetryNotice
                    message={`Edit failed: ${genError.message}`}
                    onRetry={runNlEdit}
                    disabled={isLoading}
                  />
                )}
                {showStreaming && (
                  <div className="space-y-1.5">
                    <Label className="flex items-center gap-2">
                      {isLoading ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          <span className="animate-pulse">Generating config…</span>
                        </>
                      ) : (
                        "Generated config"
                      )}
                    </Label>
                    <pre className="max-h-96 overflow-auto rounded-lg border border-border bg-surface p-4 text-xs text-muted">
                      {JSON.stringify(object, null, 2)}
                    </pre>
                  </div>
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
    </div>
  );
}

function PanelEditor({
  panel,
  sources,
  onChange,
}: {
  panel: Panel;
  sources: SourceOption[];
  onChange: (fn: (p: Panel) => Panel) => void;
}) {
  return (
    <div className="space-y-3">
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
            onValueChange={(v) => onChange((p) => ({ ...p, query: { ...p.query, sourceId: v } }))}
            options={sources.map((s) => ({ value: s.id, label: s.name }))}
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

      <div>
        <Label htmlFor="p-sql">SQL (SELECT only; no time filter — the server injects it)</Label>
        <Textarea
          id="p-sql"
          rows={4}
          className="font-mono"
          value={panel.query.sql}
          onChange={(e) => onChange((p) => ({ ...p, query: { ...p.query, sql: e.target.value } }))}
        />
      </div>

      <div>
        <Label>Width</Label>
        <Select
          value={String(panel.layout.w)}
          onValueChange={(v) =>
            onChange((p) => ({ ...p, layout: { ...p.layout, w: Number(v) } }))
          }
          options={
            WIDTH_PRESETS.some((o) => o.value === String(panel.layout.w))
              ? WIDTH_PRESETS
              : [
                  ...WIDTH_PRESETS,
                  { value: String(panel.layout.w), label: `Custom (${panel.layout.w}/12)` },
                ]
          }
        />
        <p className="mt-1 text-xs text-muted">
          Column span on the 12-col grid. Fine-tune exact position below.
        </p>
      </div>

      <div className="grid grid-cols-5 gap-2">
        <div>
          <Label htmlFor="p-tf">timeField</Label>
          <Input
            id="p-tf"
            value={panel.query.timeField ?? ""}
            onChange={(e) =>
              onChange((p) => ({
                ...p,
                query: { ...p.query, timeField: e.target.value || undefined },
              }))
            }
          />
        </div>
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
                  layout: { ...p.layout, [k]: Number(e.target.value) },
                }))
              }
            />
          </div>
        ))}
      </div>
    </div>
  );
}
