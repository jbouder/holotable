import type { LanguageModel } from "ai";

/**
 * The recorded model behind `AI_PROVIDER=stub` (#88).
 *
 * It exists so the end-to-end suite can drive every generation surface
 * deterministically, without a live model and without spending anything. It
 * never sees the network: each call answers with a recorded spec chosen by the
 * output it was asked for, streamed in a few chunks so the client's partial
 * rendering still runs.
 *
 * What it returns is a SPEC, exactly as a real model's would be — it goes
 * through the same schema, the same SQL guard and the same server-side
 * execution (invariants 1–3). It knows nothing about data; the recorded SQL
 * names the demo `http_requests` table that `timescaledb/init` creates, and a
 * source without it fails validation the same way a real model's mistake would.
 *
 * `validateConfig` refuses it in production unless `AI_STUB_IN_PRODUCTION` says
 * otherwise, so it cannot quietly stand in for a model a deployment forgot to
 * configure.
 */

type StubModel = Extract<LanguageModel, { specificationVersion: "v4" }>;
type CallOptions = Parameters<StubModel["doStream"]>[0];
type StreamPart =
  Awaited<ReturnType<StubModel["doStream"]>>["stream"] extends ReadableStream<infer P>
    ? P
    : never;
type GenerateResult = Awaited<ReturnType<StubModel["doGenerate"]>>;

/** The text the chat surface answers with, so a test can look for it. */
export const STUB_CHAT_REPLY =
  "This is a recorded reply from the stub model. It has not looked at any data.";

/** Suffix the stub appends to a panel's title when asked to change it. */
export const STUB_PANEL_EDIT_SUFFIX = " (edited)";

/** The recorded dashboard, against whichever source the prompt authorized. */
export function recordedDashboard(sourceId: string) {
  return {
    title: "Checkout service health",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 2000,
    panels: [
      {
        id: "requests",
        title: "Requests per minute",
        description: "Count of HTTP requests, bucketed by minute.",
        viz: "line",
        query: {
          sourceId,
          timeField: "minute",
          sql: "SELECT time_bucket('1 minute', ts) AS minute, count(*) AS requests FROM http_requests GROUP BY minute ORDER BY minute",
        },
        format: "number",
        layout: { x: 0, y: 0, w: 6, h: 4 },
      },
      {
        id: "by-route",
        title: "Requests by route",
        description: "Count of HTTP requests in the range, grouped by route.",
        viz: "table",
        query: {
          sourceId,
          sql: "SELECT route, count(*) AS requests FROM http_requests GROUP BY route ORDER BY requests DESC",
        },
        layout: { x: 6, y: 0, w: 6, h: 4 },
      },
    ],
  };
}

/**
 * The recorded dashboard for a Prometheus source (#387), against Holotable's
 * own metrics as a Prometheus scraping `/api/metrics` holds them, so the
 * compose stack's Prometheus can answer it.
 */
export function recordedPromqlDashboard(sourceId: string) {
  return {
    title: "Holotable query load",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 15000,
    panels: [
      {
        id: "query-rate",
        title: "Queries per second by source",
        description: "Rate of executed panel queries over 5 minutes, per source.",
        viz: "line",
        query: {
          sourceId,
          promql: "sum by (source) (rate(holotable_query_duration_seconds_count[5m]))",
        },
        format: "number",
        layout: { x: 0, y: 0, w: 6, h: 4 },
      },
      {
        id: "query-p95",
        title: "p95 query latency",
        description: "The 95th percentile of query duration over 5 minutes, in seconds.",
        viz: "line",
        query: {
          sourceId,
          promql:
            "histogram_quantile(0.95, sum by (le) (rate(holotable_query_duration_seconds_bucket[5m])))",
        },
        layout: { x: 6, y: 0, w: 6, h: 4 },
      },
      {
        id: "pollers",
        title: "Active pollers",
        description: "The number of dashboard pollers running now.",
        viz: "stat",
        query: { sourceId, promql: "sum(holotable_pollers_active)", instant: true },
        layout: { x: 0, y: 4, w: 4, h: 2 },
      },
    ],
  };
}

/**
 * The recorded dashboard for a DuckDB source (#573): the same story as
 * {@link recordedDashboard}, in DuckDB's spelling of a bucket, against an
 * `http_requests` table (the e2e stack's generated Parquet file).
 */
export function recordedDuckDbDashboard(sourceId: string) {
  const base = recordedDashboard(sourceId);
  return {
    ...base,
    title: "Request log",
    panels: base.panels.map((panel) =>
      panel.id === "requests"
        ? {
            ...panel,
            query: {
              ...panel.query,
              sql: "SELECT time_bucket(INTERVAL '1 minute', ts) AS minute, count(*) AS requests FROM http_requests GROUP BY minute ORDER BY minute",
            },
          }
        : panel,
    ),
  };
}

/**
 * The recorded dashboard for an uploaded expenses file (#595): the sample at
 * `public/samples/household-expenses.csv`, uploaded as a DuckDB source, is
 * the table `household_expenses`. No time field: the file is six months of
 * history, and these panels read all of it.
 */
export function recordedExpensesDashboard(sourceId: string) {
  return {
    title: "Household spending",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 60000,
    panels: [
      {
        id: "by-category",
        title: "Spend by category",
        description: "Total spent per category across the file.",
        viz: "bar",
        query: {
          sourceId,
          sql: "SELECT category, sum(amount) AS spend FROM household_expenses GROUP BY category ORDER BY spend DESC",
        },
        format: "number",
        layout: { x: 0, y: 0, w: 6, h: 4 },
      },
      {
        id: "by-month",
        title: "Spend by month",
        description: "Total spent per calendar month.",
        viz: "table",
        query: {
          sourceId,
          sql: "SELECT date_trunc('month', date) AS month, sum(amount) AS spend, count(*) AS payments FROM household_expenses GROUP BY month ORDER BY month",
        },
        layout: { x: 6, y: 0, w: 6, h: 4 },
      },
    ],
  };
}

/** The recorded Explore answer for a Prometheus source (#387). */
export function recordedPromqlExplorePanel(sourceId: string) {
  return {
    id: "explore",
    title: "Queries by source",
    description: "Rate of executed panel queries over 5 minutes, per source.",
    viz: "table",
    query: {
      sourceId,
      promql: "sum by (source) (rate(holotable_query_duration_seconds_count[5m]))",
      instant: true,
    },
    layout: { x: 0, y: 0, w: 12, h: 4 },
  };
}

/**
 * The stream selector the LogQL recordings (#564) read: the first label the
 * catalog lists with a value, at its first value, as a new panel's starter
 * picks one. The stub knows no Loki's labels; the prompt's catalog does.
 */
export interface LogqlStream {
  label: string;
  value: string;
}

/** `{label="value"}`, the value quoted as LogQL quotes a string. */
function selector(stream: LogqlStream): string {
  return `{${stream.label}=${JSON.stringify(stream.value)}}`;
}

/**
 * The recorded dashboard for a Loki source (#564): the stream's error lines,
 * and their rate per route, parsed from JSON lines as Holotable writes its
 * own (`src/lib/log.ts`).
 */
export function recordedLogqlDashboard(sourceId: string, stream: LogqlStream) {
  return {
    title: "Errors",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 15000,
    panels: [
      recordedLogqlLogsPanel(sourceId, stream, { x: 0, y: 0, w: 12, h: 5 }),
      {
        id: "error-rate",
        title: "Error rate by route",
        description: "Per-second rate of error lines over 5 minutes, per route.",
        viz: "line",
        query: {
          sourceId,
          logql: `sum by (route) (rate(${selector(stream)} | json | level="error" [5m]))`,
        },
        layout: { x: 0, y: 5, w: 12, h: 4 },
      },
    ],
  };
}

/** The recorded logs panel for a Loki source (#564): its error lines, newest first. */
function recordedLogqlLogsPanel(
  sourceId: string,
  stream: LogqlStream,
  layout: { x: number; y: number; w: number; h: number },
) {
  return {
    id: "errors",
    title: "Error lines",
    description: "The stream's lines whose parsed level is error, newest first.",
    viz: "logs",
    query: { sourceId, logql: `${selector(stream)} | json | level="error"` },
    options: { level: "level", limit: 200 },
    layout,
  };
}

/** The recorded Explore answer for a Loki source (#564): a logs panel. */
export function recordedLogqlExplorePanel(sourceId: string, stream: LogqlStream) {
  return {
    ...recordedLogqlLogsPanel(sourceId, stream, { x: 0, y: 0, w: 12, h: 4 }),
    id: "explore",
  };
}

/** The recorded Explore answer. */
export function recordedExplorePanel(sourceId: string) {
  return {
    id: "explore",
    title: "Requests by service",
    description: "Count of HTTP requests in the range, grouped by service.",
    viz: "table",
    query: {
      sourceId,
      sql: "SELECT service, count(*) AS requests FROM http_requests GROUP BY service ORDER BY requests DESC",
    },
    layout: { x: 0, y: 0, w: 12, h: 4 },
  };
}

/**
 * The recorded source draft. Placeholders rather than a plausible host, as the
 * real prompt demands: the form refuses to save one, so a draft can never
 * point somewhere by accident.
 */
/** The stub's Prometheus source draft (#386): a bearer endpoint with `up`. */
export function recordedPrometheusDraft(secretRef: string) {
  return {
    id: "drafted-prometheus",
    name: "Drafted Prometheus",
    secretRef,
    config: {
      kind: "prometheus",
      url: "https://prometheus.example.com",
      auth: "bearer",
      metrics: [{ name: "up", type: "gauge", labels: ["job", "instance"] }],
    },
  };
}

export function recordedSourceDraft(secretRef: string) {
  return {
    id: "drafted-metrics",
    name: "Drafted metrics",
    secretRef,
    config: {
      host: "<host>",
      port: 5432,
      database: "<database>",
      schema: "metrics",
      ssl: false,
      tables: [
        {
          name: "http_requests",
          timeField: "ts",
          columns: [{ name: "ts", type: "timestamp with time zone" }],
        },
      ],
    },
  };
}

function textOf(options: CallOptions): { system: string; user: string } {
  let system = "";
  let user = "";
  for (const message of options.prompt) {
    if (message.role === "system") system += `${message.content}\n`;
    else if (message.role === "user") {
      for (const part of message.content)
        if (part.type === "text") user += `${part.text}\n`;
    }
  }
  return { system, user };
}

/** The JSON object after `marker` in the prompt: the spec a change applies to. */
function currentSpecAfter(text: string, marker: string): Record<string, unknown> | null {
  const start = text.indexOf(marker);
  if (start < 0) return null;
  const open = text.indexOf("{", start);
  if (open < 0) return null;
  // The spec is pretty-printed JSON; walk to its matching brace, skipping
  // braces inside strings.
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(open, i + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * The stream a Loki source's recordings read, from its catalog in the prompt
 * (`- <label> -- values seen: <value>, …`); null for a source of another kind.
 */
export function logqlStreamOf(system: string, sourceId: string): LogqlStream | null {
  if (!system.includes(`(id: ${sourceId}, kind: loki)`)) return null;
  const listed = /^- ([A-Za-z_][A-Za-z0-9_]*) -- values seen: ([^,\n]+)/m.exec(system);
  return listed
    ? { label: listed[1], value: listed[2].trim() }
    : { label: "app", value: "app" };
}

/** The recorded panel answer for a source, by its kind. */
function recordedPanelFor(system: string, sourceId: string) {
  const stream = logqlStreamOf(system, sourceId);
  if (stream) return recordedLogqlExplorePanel(sourceId, stream);
  return system.includes(`(id: ${sourceId}, kind: prometheus)`)
    ? recordedPromqlExplorePanel(sourceId)
    : recordedExplorePanel(sourceId);
}

/** The answer to one call, as the text a model would have streamed. */
export function stubAnswer(options: CallOptions): string {
  const { system, user } = textOf(options);
  const sourceId = /^sourceId: (\S+)$/m.exec(system)?.[1] ?? "unknown-source";
  // A request against a Prometheus source (its catalog line says so) gets the
  // PromQL recordings (#387), and one against a Loki source the LogQL ones
  // (#564).
  const promql = system.includes(`(id: ${sourceId}, kind: prometheus)`);
  const stream = logqlStreamOf(system, sourceId);
  // And a DuckDB source gets its own bucket spelling (#573).
  const duckdb = system.includes(`(id: ${sourceId}, kind: duckdb)`);
  const format = options.responseFormat;
  if (format?.type !== "json") return STUB_CHAT_REPLY;

  switch (format.name) {
    case "Dashboard": {
      const current = currentSpecAfter(user, "Here is the current dashboard spec:");
      if (current) {
        return JSON.stringify({
          ...current,
          title: `${String(current.title)} (refined)`,
        });
      }
      return JSON.stringify(
        stream
          ? recordedLogqlDashboard(sourceId, stream)
          : promql
            ? recordedPromqlDashboard(sourceId)
            : duckdb
              ? // An uploaded expenses file (#595) gets its own recording.
                /^- household_expenses\b/m.test(system)
                ? recordedExpensesDashboard(sourceId)
                : recordedDuckDbDashboard(sourceId)
              : recordedDashboard(sourceId),
      );
    }
    case "Panel": {
      const current = currentSpecAfter(user, "Here is the current panel spec:");
      if (current) {
        return JSON.stringify({
          ...current,
          title: `${String(current.title)}${STUB_PANEL_EDIT_SUFFIX}`,
        });
      }
      return JSON.stringify(recordedPanelFor(system, sourceId));
    }
    case "SourceDraft": {
      const granted = /MUST be one of: "([^"]+)"/.exec(system)?.[1] ?? "TS_METRICS";
      // A description that asks for Prometheus gets the Prometheus recording (#386).
      return JSON.stringify(
        /prometheus/i.test(user)
          ? recordedPrometheusDraft(granted)
          : recordedSourceDraft(granted),
      );
    }
    default:
      return "{}";
  }
}

/**
 * The recorded Chat turn (#416): offered `showPanel`, and not yet answering
 * its result, the stub draws the recorded Explore panel (without the id and
 * layout the server assigns), against whichever source the prompt lists
 * first; with the result in hand it answers {@link STUB_CHAT_REPLY}.
 */
export function stubToolCall(
  options: CallOptions,
): { toolName: string; input: string } | null {
  const offered = options.tools?.some(
    (t) => t.type === "function" && t.name === "showPanel",
  );
  if (!offered || options.prompt.at(-1)?.role === "tool") return null;
  const { system } = textOf(options);
  const sourceId = /^sourceId: (\S+)$/m.exec(system)?.[1] ?? "unknown-source";
  const { id: _id, layout: _layout, ...panel } = recordedPanelFor(system, sourceId);
  return { toolName: "showPanel", input: JSON.stringify(panel) };
}

/** Split into a handful of deltas, so partial rendering is exercised. */
function chunks(text: string, count = 4): string[] {
  const size = Math.max(1, Math.ceil(text.length / count));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};
const FINISH = { unified: "stop", raw: "stop" } as const;
const TOOL_CALLS = { unified: "tool-calls", raw: "tool_calls" } as const;

export function stubModel(): StubModel {
  return {
    specificationVersion: "v4",
    provider: "holotable-stub",
    modelId: "stub",
    supportedUrls: {},
    async doGenerate(options): Promise<GenerateResult> {
      const call = stubToolCall(options);
      if (call) {
        return {
          content: [{ type: "tool-call", toolCallId: "stub-call", ...call }],
          finishReason: TOOL_CALLS,
          usage: USAGE,
          warnings: [],
        };
      }
      return {
        content: [{ type: "text", text: stubAnswer(options) }],
        finishReason: FINISH,
        usage: USAGE,
        warnings: [],
      };
    },
    async doStream(options) {
      const call = stubToolCall(options);
      const parts: StreamPart[] = call
        ? [
            { type: "stream-start", warnings: [] },
            {
              type: "response-metadata",
              id: "stub",
              modelId: "stub",
              timestamp: new Date(),
            },
            { type: "tool-call", toolCallId: "stub-call", ...call },
            { type: "finish", finishReason: TOOL_CALLS, usage: USAGE },
          ]
        : [
            { type: "stream-start", warnings: [] },
            {
              type: "response-metadata",
              id: "stub",
              modelId: "stub",
              timestamp: new Date(),
            },
            { type: "text-start", id: "t" },
            ...chunks(stubAnswer(options)).map(
              (delta): StreamPart => ({ type: "text-delta", id: "t", delta }),
            ),
            { type: "text-end", id: "t" },
            { type: "finish", finishReason: FINISH, usage: USAGE },
          ];
      return {
        stream: new ReadableStream<StreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
}
