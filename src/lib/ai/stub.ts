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

/** The answer to one call, as the text a model would have streamed. */
export function stubAnswer(options: CallOptions): string {
  const { system, user } = textOf(options);
  const sourceId = /^sourceId: (\S+)$/m.exec(system)?.[1] ?? "unknown-source";
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
      return JSON.stringify(recordedDashboard(sourceId));
    }
    case "Panel": {
      const current = currentSpecAfter(user, "Here is the current panel spec:");
      if (current) {
        return JSON.stringify({
          ...current,
          title: `${String(current.title)}${STUB_PANEL_EDIT_SUFFIX}`,
        });
      }
      return JSON.stringify(recordedExplorePanel(sourceId));
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

export function stubModel(): StubModel {
  return {
    specificationVersion: "v4",
    provider: "holotable-stub",
    modelId: "stub",
    supportedUrls: {},
    async doGenerate(options): Promise<GenerateResult> {
      return {
        content: [{ type: "text", text: stubAnswer(options) }],
        finishReason: FINISH,
        usage: USAGE,
        warnings: [],
      };
    },
    async doStream(options) {
      const parts: StreamPart[] = [
        { type: "stream-start", warnings: [] },
        { type: "response-metadata", id: "stub", modelId: "stub", timestamp: new Date() },
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
