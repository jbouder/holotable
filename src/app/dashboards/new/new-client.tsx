"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { experimental_useObject as useObject } from "@ai-sdk/react";
import { Loader2, Sparkles, Save } from "lucide-react";
import { Dashboard, safeParseDashboard } from "@/lib/ir";
import { autoLayoutPanels, DEFAULT_COLUMNS } from "@/lib/layout";
import { Button } from "@/components/ui/button";
import { Textarea, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { PreviewDashboard } from "@/components/dashboard/PreviewDashboard";

interface SourceOption {
  id: string;
  name: string;
  workspaceId: string;
}

export function NewDashboardClient({ sources }: { sources: SourceOption[] }) {
  const router = useRouter();
  const [sourceId, setSourceId] = React.useState<string | null>(
    sources[0]?.id ?? null,
  );
  const [prompt, setPrompt] = React.useState("");
  const [finalSpec, setFinalSpec] = React.useState<Dashboard | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const { object, submit, isLoading, error, stop } = useObject({
    api: "/api/generate",
    schema: Dashboard,
    onFinish({ object }) {
      if (!object) return;
      // Arrange panels two-up by default; the model's raw {x,y,w,h} guesses
      // often overlap. Users can rearrange in the editor.
      setFinalSpec({
        ...object,
        panels: autoLayoutPanels(object.panels, DEFAULT_COLUMNS),
      });
    },
  });

  function generate() {
    if (!sourceId || !prompt.trim()) return;
    setFinalSpec(null);
    setSaveError(null);
    submit({ mode: "dashboard", sourceId, prompt });
  }

  async function save() {
    if (!finalSpec) return;
    setSaving(true);
    setSaveError(null);
    const parsed = safeParseDashboard(finalSpec);
    if (!parsed.success) {
      setSaveError("generated spec is invalid");
      setSaving(false);
      return;
    }
    const res = await fetch("/api/dashboards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: parsed.data }),
    });
    const body = await res.json();
    setSaving(false);
    if (!res.ok) {
      setSaveError(body.error ?? "save failed");
      return;
    }
    router.push(`/dashboards/${body.dashboard.id}`);
  }

  const showStreaming = isLoading || object !== undefined;

  if (sources.length === 0) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card>
          <CardContent className="text-sm text-muted">
            You have no data sources to build from. Create one under Data
            sources first.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <h1 className="text-2xl font-semibold">New dashboard</h1>

      <Card>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <Label htmlFor="source">Data source</Label>
              <Select
                id="source"
                value={sourceId}
                onValueChange={setSourceId}
                options={sources.map((s) => ({
                  value: s.id,
                  label: `${s.name} (${s.workspaceId})`,
                }))}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="prompt">Describe the dashboard</Label>
            <Textarea
              id="prompt"
              rows={3}
              placeholder="e.g. Show request rate, p95 latency, and error ratio over the last hour"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={generate} disabled={isLoading || !prompt.trim()}>
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              Generate
            </Button>
            {isLoading && (
              <Button variant="ghost" size="sm" onClick={() => stop()}>
                Stop
              </Button>
            )}
            {finalSpec && (
              <Button variant="secondary" onClick={save} disabled={saving}>
                <Save className="h-4 w-4" /> Save
              </Button>
            )}
          </div>
          {error && (
            <p className="text-sm text-danger">Generation failed: {error.message}</p>
          )}
          {saveError && <p className="text-sm text-danger">{saveError}</p>}
        </CardContent>
      </Card>

      {(finalSpec || showStreaming) && (
        <section>
          <h2 className="mb-3 text-lg font-medium">
            {finalSpec ? "Preview" : "Generating…"}
          </h2>
          {finalSpec ? (
            <PreviewDashboard spec={finalSpec} />
          ) : (
            <pre className="max-h-96 overflow-auto rounded-lg border border-border bg-surface p-4 text-xs text-muted">
              {JSON.stringify(object, null, 2)}
            </pre>
          )}
        </section>
      )}
    </div>
  );
}
