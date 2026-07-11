"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { experimental_useObject as useObject } from "@ai-sdk/react";
import { Plus, Trash2, Save, Sparkles, Loader2, Eye } from "lucide-react";
import { Dashboard, Panel, VizType, ValueFormat, safeParseDashboard } from "@/lib/ir";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PreviewDashboard } from "@/components/dashboard/PreviewDashboard";

interface SourceOption {
  id: string;
  name: string;
  workspaceId: string;
}

const VIZ_OPTIONS = VizType.options.map((v) => ({ value: v, label: v }));
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
  const [showPreview, setShowPreview] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [nlPrompt, setNlPrompt] = React.useState("");

  const selected = spec.panels.find((p) => p.id === selectedId) ?? null;

  const { submit, isLoading } = useObject({
    api: "/api/generate",
    schema: Panel,
    onFinish({ object }) {
      if (object) updatePanel(object.id, () => object);
    },
  });

  function updateSpec(patch: Partial<Dashboard>) {
    setSpec((s) => ({ ...s, ...patch }));
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
      layout: { x: 0, y: maxY, w: 6, h: 3 },
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
    <div className="mx-auto max-w-7xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Edit dashboard</h1>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setShowPreview((v) => !v)}>
            <Eye className="h-4 w-4" /> {showPreview ? "Hide" : "Preview"}
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save version
          </Button>
        </div>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}

      <Card>
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
          <CardContent className="space-y-1">
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
                <Textarea
                  id="nl"
                  rows={2}
                  placeholder="e.g. change to a bar chart grouped by status code"
                  value={nlPrompt}
                  onChange={(e) => setNlPrompt(e.target.value)}
                />
                <Button size="sm" onClick={runNlEdit} disabled={isLoading || !nlPrompt.trim()}>
                  {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  Apply NL edit
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {showPreview && (
        <section>
          <h2 className="mb-3 text-lg font-medium">Preview</h2>
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
