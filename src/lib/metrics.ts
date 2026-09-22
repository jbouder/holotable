import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "@prometheus-io/client";

/**
 * Prometheus instrumentation.
 *
 * Everything the server already knows about itself — how long a poller tick
 * takes, how long a metrics query runs and how many rows it returns, how many
 * browsers are attached to a dashboard, what the model costs, what the SQL
 * guard rejects — lives only as in-process state. This module is the one place
 * that turns that state into a scrape.
 *
 * Three rules hold here.
 *
 * 1. **Its own registry.** Nothing registers into the library's global default
 *    register, so `renderMetrics()` returns exactly the metrics defined below
 *    plus the default process collectors, and a test can reset the whole set.
 *
 * 2. **One instance per process.** Next may bundle a route handler and a
 *    server library into separate chunks, which would otherwise give
 *    `/api/metrics` a different registry from the one the poller writes to and
 *    serve an empty scrape. The registry is therefore cached on `globalThis`,
 *    the same way a connection pool would be.
 *
 * 3. **Bounded label cardinality.** A label value is either a fixed enum
 *    member or an opaque id, and every id goes through {@link bounded}, which
 *    caps the number of distinct values a label may ever take and folds the
 *    rest into `other`. No user-supplied text, no SQL, no error message is
 *    ever a label. A series is also dropped when the thing it describes goes
 *    away (see {@link forgetDashboard}), so a long-lived process does not
 *    accumulate one gauge per dashboard that ever existed.
 *
 * Reading the values requires `METRICS_TOKEN` or a network restriction; the
 * gate lives in `src/lib/metrics-access.ts`.
 */

/**
 * Distinct values a single id label may take before further ones collapse into
 * `other`. Generous enough that a real deployment never reaches it, low enough
 * that a runaway cannot blow up the scrape or the server's memory.
 */
const MAX_LABEL_VALUES = 500;

/** The value substituted once a label has seen {@link MAX_LABEL_VALUES} ids. */
export const OVERFLOW_LABEL = "other";

/** Why the SQL guard refused a statement. A fixed enum, safe as a label. */
export type SqlRejectionReason =
  | "empty"
  | "structure"
  | "comment"
  | "keyword"
  | "function"
  | "time"
  | "catalog";

/** What happened to a model request at the admission gate. */
export type LlmRequestOutcome = "admitted" | "rate_limited" | "over_budget";

/** Which side of a model call the tokens were spent on. */
export type TokenDirection = "input" | "output";

interface Instruments {
  registry: Registry;
  pollerTickDuration: Histogram<"dashboard">;
  queryDuration: Histogram<"source" | "outcome">;
  queryRows: Histogram<"source">;
  sseSubscribers: Gauge<"dashboard">;
  pollersActive: Gauge<string>;
  llmTokens: Counter<"workspace" | "model" | "direction">;
  llmRequests: Counter<"route" | "outcome">;
  sqlRejections: Counter<"reason">;
  /** One set of seen values per bounded label, keyed `metric/label`. */
  seenLabelValues: Map<string, Set<string>>;
}

function build(): Instruments {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: "holotable_" });

  return {
    registry,
    pollerTickDuration: new Histogram({
      name: "holotable_poller_tick_duration_seconds",
      help: "Wall time of one dashboard poller tick, across all of its panels.",
      labelNames: ["dashboard"],
      // A tick runs every panel; the useful range is a refresh interval
      // (2s minimum, 15s default) either side of the query timeout (20s).
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60],
      registers: [registry],
    }),
    queryDuration: new Histogram({
      name: "holotable_query_duration_seconds",
      help: "Wall time of one guarded query against a metrics source, including connect and rollback.",
      labelNames: ["source", "outcome"],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30],
      registers: [registry],
    }),
    queryRows: new Histogram({
      name: "holotable_query_rows",
      help: "Rows returned by one guarded query. Bounded by MAX_QUERY_ROWS.",
      labelNames: ["source"],
      buckets: [0, 1, 10, 50, 100, 500, 1_000, 2_500, 5_000, 10_000],
      registers: [registry],
    }),
    sseSubscribers: new Gauge({
      name: "holotable_sse_subscribers",
      help: "Browsers currently attached to a dashboard's event stream on this instance.",
      labelNames: ["dashboard"],
      registers: [registry],
    }),
    pollersActive: new Gauge({
      name: "holotable_pollers_active",
      help: "Dashboard pollers running on this instance.",
      registers: [registry],
    }),
    llmTokens: new Counter({
      name: "holotable_llm_tokens_total",
      help: "Model tokens billed to a workspace, by model and direction.",
      labelNames: ["workspace", "model", "direction"],
      registers: [registry],
    }),
    llmRequests: new Counter({
      name: "holotable_llm_requests_total",
      help: "Model requests seen by the admission gate, by route and what the gate decided.",
      labelNames: ["route", "outcome"],
      registers: [registry],
    }),
    sqlRejections: new Counter({
      name: "holotable_sql_validation_rejections_total",
      help: "Statements refused by the SQL guard, by the kind of rule that refused them.",
      labelNames: ["reason"],
      registers: [registry],
    }),
    seenLabelValues: new Map(),
  };
}

/**
 * The process-wide instruments. Cached on `globalThis` so every bundle that
 * imports this module — route handler, poller, SQL guard — writes to and reads
 * from the same registry.
 */
const CACHE_KEY = Symbol.for("holotable.metrics");
type Cache = { [CACHE_KEY]?: Instruments };

function instruments(): Instruments {
  const cache = globalThis as Cache;
  cache[CACHE_KEY] ??= build();
  return cache[CACHE_KEY];
}

/**
 * Cap the distinct values one label may take. The first
 * {@link MAX_LABEL_VALUES} ids are passed through; everything after them is
 * reported as {@link OVERFLOW_LABEL}, so a scrape stays a fixed size no matter
 * how many dashboards, sources or workspaces the process has seen.
 */
function bounded(metric: string, label: string, value: string): string {
  const { seenLabelValues } = instruments();
  const key = `${metric}/${label}`;
  let seen = seenLabelValues.get(key);
  if (!seen) {
    seen = new Set();
    seenLabelValues.set(key, seen);
  }
  if (seen.has(value)) return value;
  if (seen.size >= MAX_LABEL_VALUES) return OVERFLOW_LABEL;
  seen.add(value);
  return value;
}

/** Record one poller tick. `seconds` is wall time across every panel. */
export function observePollerTick(dashboardId: string, seconds: number): void {
  const m = instruments();
  m.pollerTickDuration.observe(
    { dashboard: bounded("poller_tick", "dashboard", dashboardId) },
    seconds,
  );
}

/**
 * Record one guarded query. `rows` is omitted when the query failed — a failed
 * statement returned no result, and observing zero would pull the row
 * histogram down as if it had.
 */
export function observeQuery(input: {
  sourceId: string;
  seconds: number;
  ok: boolean;
  rows?: number;
}): void {
  const m = instruments();
  const source = bounded("query", "source", input.sourceId);
  m.queryDuration.observe({ source, outcome: input.ok ? "ok" : "error" }, input.seconds);
  if (input.ok && input.rows !== undefined) m.queryRows.observe({ source }, input.rows);
}

/** Report a dashboard's current subscriber count on this instance. */
export function setSseSubscribers(dashboardId: string, count: number): void {
  const m = instruments();
  m.sseSubscribers.set({ dashboard: bounded("sse", "dashboard", dashboardId) }, count);
}

/** Report how many pollers are running on this instance. */
export function setActivePollers(count: number): void {
  instruments().pollersActive.set(count);
}

/**
 * Drop a dashboard's per-dashboard series. Called when its poller stops, so a
 * dashboard that is deleted or simply goes unwatched stops being exported
 * rather than sitting at zero forever.
 */
export function forgetDashboard(dashboardId: string): void {
  const m = instruments();
  m.sseSubscribers.remove({ dashboard: bounded("sse", "dashboard", dashboardId) });
}

/** Record one finished model call's token usage. */
export function recordLlmTokens(input: {
  workspaceId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}): void {
  const m = instruments();
  const workspace = bounded("llm", "workspace", input.workspaceId);
  const model = bounded("llm", "model", input.model);
  const add = (direction: TokenDirection, tokens: number) => {
    if (tokens > 0) m.llmTokens.inc({ workspace, model, direction }, tokens);
  };
  add("input", input.inputTokens);
  add("output", input.outputTokens);
}

/** Record what the LLM admission gate decided about one request. */
export function recordLlmRequest(route: string, outcome: LlmRequestOutcome): void {
  instruments().llmRequests.inc({ route, outcome });
}

/** Record one statement refused by the SQL guard. */
export function recordSqlRejection(reason: SqlRejectionReason): void {
  instruments().sqlRejections.inc({ reason });
}

/** The scrape body, in the Prometheus text exposition format. */
export function renderMetrics(): Promise<string> {
  return instruments().registry.metrics();
}

/** The `Content-Type` the exposition format must be served with. */
export function metricsContentType(): string {
  return instruments().registry.contentType;
}

/** Test helper: drop every recorded value and every remembered label value. */
export function resetMetricsForTests(): void {
  const cache = globalThis as Cache;
  cache[CACHE_KEY]?.registry.clear();
  delete cache[CACHE_KEY];
}
