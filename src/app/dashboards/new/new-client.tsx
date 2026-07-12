"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { experimental_useObject as useObject } from "@ai-sdk/react";
import { Loader2, SendHorizontal, Save } from "lucide-react";
import { Dashboard, safeParseDashboard } from "@/lib/ir";
import { autoLayoutPanels, DEFAULT_COLUMNS } from "@/lib/layout";
import { Button } from "@/components/ui/button";
import { Textarea, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PreviewDashboard } from "@/components/dashboard/PreviewDashboard";
import { RetryNotice } from "@/components/dashboard/RetryNotice";

interface SourceOption {
  id: string;
  name: string;
  workspaceId: string;
}

/** Starter prompts to seed the textarea with one click. */
const PROMPT_PRESETS = [
  "p95 and p99 latency trends over time",
  "HTTP status code breakdown over time",
  "Slowest endpoints by p95 latency",
  "Total requests and error count as stat panels",
  "Request rate and error ratio over the last hour",
];

export function NewDashboardClient({
  sources,
  model,
}: {
  sources: SourceOption[];
  model: string;
}) {
  const router = useRouter();
  const [activeTab, setActiveTab] = React.useState<"chat" | "preview">("chat");
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
      setActiveTab("preview");
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
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold">New dashboard</h1>
            {model && <Badge title="Generation model">{model}</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted">
            Describe the dashboard you want in plain English. The model generates
            a validated spec, then preview and save it as live panels.
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
                  options={sources.map((s) => ({
                    value: s.id,
                    label: `${s.name} (${s.workspaceId})`,
                  }))}
                />
              </div>
            </div>
            <div>
              <Label htmlFor="prompt">Describe the dashboard or try one below</Label>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                {PROMPT_PRESETS.map((preset) => (
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
              <div className="relative">
                <Textarea
                  id="prompt"
                  rows={3}
                  className="pr-14"
                  placeholder="e.g. Show request rate, p95 latency, and error ratio over the last hour"
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
                  aria-label="Generate"
                  title="Generate"
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
                  <Button variant="secondary" onClick={save} disabled={saving}>
                    <Save className="h-4 w-4" /> Save
                  </Button>
                )}
              </div>
            )}
            {error && (
              <RetryNotice
                message={`Generation failed: ${error.message}`}
                onRetry={generate}
                disabled={isLoading}
              />
            )}
            {saveError && <p className="text-sm text-danger">{saveError}</p>}
          </CardContent>
        </Card>

        {showStreaming && (
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
                {JSON.stringify(object, null, 2)}
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
    </div>
  );
}
