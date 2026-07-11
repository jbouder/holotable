"use client";

import * as React from "react";
import { experimental_useObject as useObject } from "@ai-sdk/react";
import { Loader2, Sparkles, Compass, AlertTriangle, RefreshCw } from "lucide-react";
import { Panel, TimeRange } from "@/lib/ir";
import { Button } from "@/components/ui/button";
import { Textarea, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { EChart } from "@/components/charts/EChart";
import { buildChartOption, type PanelData } from "@/components/charts/options";
import { RetryNotice } from "@/components/dashboard/RetryNotice";
import { formatValue } from "@/lib/format";

interface SourceOption {
  id: string;
  name: string;
  workspaceId: string;
}

type Status = "loading" | "done" | "error";

interface Result {
  data: PanelData;
  status: Status;
  error?: string;
}

const CHART_VIZ = new Set(["line", "bar", "heatmap"]);
const MAX_TABLE_ROWS = 500;
const EMPTY: PanelData = { columns: [], rows: [] };

const TIME_PRESETS: { value: string; label: string }[] = [
  { value: "now-15m", label: "Last 15 minutes" },
  { value: "now-1h", label: "Last 1 hour" },
  { value: "now-6h", label: "Last 6 hours" },
  { value: "now-24h", label: "Last 24 hours" },
  { value: "now-7d", label: "Last 7 days" },
];

// One-click sample questions for quick testing. Chosen to exercise the seeded
// http_requests catalog and a spread of viz types (line / table / stat).
const EXAMPLE_PROMPTS: string[] = [
  "Chart request volume per minute",
  "Chart p95 latency over time",
  "Which routes returned the most 5xx errors?",
  "Top routes by request count",
  "Total requests in this window",
];

export function ExploreClient({ sources }: { sources: SourceOption[] }) {
  const [sourceId, setSourceId] = React.useState<string | null>(
    sources[0]?.id ?? null,
  );
  const [from, setFrom] = React.useState("now-1h");
  const [prompt, setPrompt] = React.useState("");
  const [panel, setPanel] = React.useState<Panel | null>(null);
  const [result, setResult] = React.useState<Result | null>(null);

  const runQuery = React.useCallback(
    async (p: Panel, timeRange: TimeRange) => {
      setResult({ data: EMPTY, status: "loading" });
      try {
        const res = await fetch("/api/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sourceId: p.query.sourceId,
            sql: p.query.sql,
            timeField: p.query.timeField,
            timeRange,
          }),
        });
        const body = await res.json();
        if (!res.ok) {
          setResult({ data: EMPTY, status: "error", error: body.error ?? "query failed" });
          return;
        }
        setResult({ data: { columns: body.columns, rows: body.rows }, status: "done" });
      } catch (err) {
        setResult({
          data: EMPTY,
          status: "error",
          error: err instanceof Error ? err.message : "query failed",
        });
      }
    },
    [],
  );

  const { object, submit, isLoading, error, stop } = useObject({
    api: "/api/generate",
    schema: Panel,
    onFinish({ object }) {
      if (!object || !sourceId) return;
      // The panel query carries the source id; pin it to the selected source.
      const finalized: Panel = {
        ...object,
        query: { ...object.query, sourceId },
      };
      setPanel(finalized);
      void runQuery(finalized, { from, to: "now" });
    },
  });

  function generate() {
    if (!sourceId || !prompt.trim()) return;
    setPanel(null);
    setResult(null);
    submit({ mode: "explore", sourceId, prompt });
  }

  // Re-run the guarded query against the new window when the range changes.
  function changeRange(next: string) {
    setFrom(next);
    if (panel) void runQuery(panel, { from: next, to: "now" });
  }

  const streaming = isLoading || object !== undefined;
  const rangeLabel = TIME_PRESETS.find((p) => p.value === from)?.label ?? from;
  const sourceName = sources.find((s) => s.id === sourceId)?.name ?? sourceId;

  if (sources.length === 0) {
    return (
      <Card>
        <CardContent className="text-sm text-muted">
          You have no data sources to explore. Create one under Data sources
          first.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="w-full space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Explore</h1>
        <p className="text-sm text-muted">
          Ask a question in plain English. Results come back as text and tables;
          ask to &ldquo;chart&rdquo;, &ldquo;plot&rdquo;, or &ldquo;graph&rdquo;
          something to get a visualization.
        </p>
      </div>

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
            <div>
              <Label htmlFor="range">Time range</Label>
              <Select
                id="range"
                value={from}
                onValueChange={changeRange}
                options={TIME_PRESETS}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="prompt">Ask a question or try one below</Label>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              {EXAMPLE_PROMPTS.map((example) => (
                <button
                  key={example}
                  type="button"
                  disabled={isLoading}
                  onClick={() => setPrompt(example)}
                  className="rounded-full border border-border bg-surface px-3 py-1 text-xs text-muted transition-colors hover:border-primary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {example}
                </button>
              ))}
            </div>
            <Textarea
              id="prompt"
              rows={3}
              placeholder="e.g. Which routes had the most errors? (add “as a chart” to visualize)"
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
              Explore
            </Button>
            {isLoading && (
              <Button variant="ghost" size="sm" onClick={() => stop()}>
                Stop
              </Button>
            )}
          </div>
          {error && (
            <RetryNotice
              message={`Generation failed: ${error.message}`}
              onRetry={generate}
              disabled={isLoading}
            />
          )}
        </CardContent>
      </Card>

      {panel ? (
        <ResultView
          panel={panel}
          result={result}
          sourceName={sourceName ?? ""}
          rangeLabel={rangeLabel}
          onRetry={() => void runQuery(panel, { from, to: "now" })}
        />
      ) : (
        streaming && (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Compass className="h-4 w-4 animate-pulse" /> Composing a query…
          </div>
        )
      )}
    </div>
  );
}

function ResultView({
  panel,
  result,
  sourceName,
  rangeLabel,
  onRetry,
}: {
  panel: Panel;
  result: Result | null;
  sourceName: string;
  rangeLabel: string;
  onRetry: () => void;
}) {
  const data = result?.data ?? EMPTY;
  const rowCount = data.rows.length;

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-lg font-medium">{panel.title}</h2>
        {panel.description && (
          <p className="text-sm text-muted">{panel.description}</p>
        )}
        <p className="text-xs text-muted">
          {sourceName} · {rangeLabel}
          {result?.status === "done" &&
            ` · ${rowCount} row${rowCount === 1 ? "" : "s"}`}
        </p>
      </div>

      <ResultBody panel={panel} result={result} data={data} onRetry={onRetry} />

      <details className="rounded-lg border border-border bg-surface">
        <summary className="cursor-pointer px-4 py-2 text-sm text-muted">
          Generated SQL
        </summary>
        <pre className="overflow-auto border-t border-border px-4 py-3 text-xs text-muted">
          {panel.query.sql}
        </pre>
      </details>
    </section>
  );
}

function ResultBody({
  panel,
  result,
  data,
  onRetry,
}: {
  panel: Panel;
  result: Result | null;
  data: PanelData;
  onRetry: () => void;
}) {
  if (!result || result.status === "loading") {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Loader2 className="h-4 w-4 animate-spin" /> Running query…
      </div>
    );
  }
  if (result.status === "error") {
    return (
      <div className="flex flex-col items-start gap-2">
        <div className="flex items-center gap-2 text-sm text-danger">
          <AlertTriangle className="h-4 w-4" /> {result.error ?? "Query failed"}
        </div>
        <Button variant="secondary" size="sm" onClick={onRetry}>
          <RefreshCw className="h-3.5 w-3.5" /> Retry
        </Button>
      </div>
    );
  }
  if (data.rows.length === 0) {
    return <p className="text-sm text-muted">No rows returned for this window.</p>;
  }

  if (CHART_VIZ.has(panel.viz)) {
    return (
      <div className="h-96 rounded-lg border border-border bg-surface p-2">
        <EChart option={buildChartOption(panel, data)} />
      </div>
    );
  }
  if (panel.viz === "stat") {
    return <StatView panel={panel} data={data} />;
  }
  return <ResultTable panel={panel} data={data} />;
}

function StatView({ panel, data }: { panel: Panel; data: PanelData }) {
  const last = data.rows[data.rows.length - 1];
  const valueKey =
    data.columns.find(
      (c) => c !== panel.query.timeField && typeof last?.[c] === "number",
    ) ?? data.columns[data.columns.length - 1];
  const value = last?.[valueKey];
  return (
    <div className="rounded-lg border border-border bg-surface px-6 py-8">
      <div className="text-4xl font-semibold tabular-nums">
        {value === undefined ? "—" : formatValue(value, panel.format)}
      </div>
      <div className="mt-1 text-sm text-muted">{valueKey}</div>
    </div>
  );
}

function ResultTable({ panel, data }: { panel: Panel; data: PanelData }) {
  const rows = data.rows.slice(0, MAX_TABLE_ROWS);
  return (
    <div className="space-y-2">
      <div className="max-h-[32rem] overflow-auto rounded-lg border border-border">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-surface-2 text-muted">
            <tr>
              {data.columns.map((c) => (
                <th key={c} className="px-3 py-2 font-medium">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-border">
                {data.columns.map((c) => (
                  <td key={c} className="px-3 py-1.5 tabular-nums">
                    {formatCell(r[c], c === panel.query.timeField ? undefined : panel.format)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.rows.length > MAX_TABLE_ROWS && (
        <p className="text-xs text-muted">
          Showing first {MAX_TABLE_ROWS} of {data.rows.length} rows.
        </p>
      )}
    </div>
  );
}

function formatCell(value: unknown, format: Panel["format"]): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" && format) return formatValue(value, format);
  return String(value);
}
