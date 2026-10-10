import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type LanguageModel, streamObject } from "ai";
import { z } from "zod";
import { dashboardRequest, explorePanelRequest } from "@/lib/ai/generate";
import { PROVIDER_OPTIONS } from "@/lib/ai/provider";
import { describeFailure } from "@/lib/ai/repair";
import { resolveAndValidateDashboard } from "@/lib/dashboard-service";
import {
  Dashboard,
  declaredVariables,
  hasQuery,
  type Panel,
  SPEC_VERSION,
  isPromqlQuery,
  isSqlQuery,
  type PromqlQuery,
  queryTimeField,
  type QueryPanel,
  type SqlQuery,
} from "@/lib/ir";
import { PANEL_KINDS } from "@/lib/panels/registry";
import { nodes, parsePromql, text as nodeText } from "@/lib/promql/parse";
import { selectorsOf } from "@/lib/promql/safety";
import { SourceConfig as SourceConfigSchema, type SourceRecord } from "@/lib/registry";
import { serverKind } from "@/lib/sources/server/registry";
import { analyzeSelect } from "@/lib/sql/ast";
import { selectOutputs, timeFieldWarning } from "@/lib/sql/hints";
import { ChatStep, chatReplayModel, chatRequest, runChatTurn } from "./eval-chat";

/*
 * The LLM eval harness (#24): a fixed corpus of prompts, each run through the
 * same request the app makes, and graded on what the app would do with the
 * answer.
 *
 * Every case is held to four checks:
 *   1. the output parses against the IR the route binds it to;
 *   2. every panel's SQL passes the guard against the case's catalog, the way
 *      a save re-validates it (`resolveAndValidateDashboard`);
 *   3. a `timeField` is a column the query actually returns;
 *   4. the case's own expectations: which viz kinds are plausible or required,
 *      which tables must be read, whether panels are time series.
 *
 * Recorded answers make the same grading free and deterministic (`--replay`,
 * every pull request); a live run against the configured provider measures
 * the model and the prompt as they are now (`--live`, nightly).
 */

export const EVALS_DIR = join(process.cwd(), "evals");

const VIZ_KINDS = PANEL_KINDS.map((k) => k.kind) as [string, ...string[]];
const Viz = z.enum(VIZ_KINDS);

export const EvalCase = z
  .object({
    /** Also the file name, `evals/corpus/<name>.json`. */
    name: z.string().regex(/^[a-z0-9-]+$/),
    /**
     * Which generation the case runs: a whole dashboard, one explore panel, or
     * one Chat turn (#416), graded on the panels it drew.
     */
    mode: z.enum(["dashboard", "explore", "chat"]),
    /** A catalog in `evals/catalogs/<catalog>.json`: a `SourceConfig`. */
    catalog: z.string().regex(/^[a-z0-9-]+$/),
    prompt: z.string().min(1).max(4000),
    /**
     * The workspace's other dashboards (#375), as the route would list them
     * for the DASHBOARDS block. Absent: a dashboard case runs with none.
     */
    dashboards: z
      .array(
        z
          .object({
            id: z.string().min(1),
            title: z.string().min(1),
            variables: z.array(z.string()),
          })
          .strict(),
      )
      .max(30)
      .optional(),
    expect: z
      .object({
        /** Every query panel's viz must be one of these. */
        plausibleViz: z.array(Viz).min(1).optional(),
        /** At least one panel of each of these. */
        requiredViz: z.array(Viz).min(1).optional(),
        /** Each table must be read by at least one panel. */
        tables: z.array(z.string()).min(1).optional(),
        /** Each metric must be named by at least one PromQL panel (#387). */
        metrics: z.array(z.string()).min(1).optional(),
        /** Every query panel sets `query.timeField` (`required`) or none does (`absent`). */
        timeField: z.enum(["required", "absent"]).optional(),
        minPanels: z.number().int().nonnegative().optional(),
        maxPanels: z.number().int().nonnegative().optional(),
        /** A chat turn (#416) fetched rows in words (`required`), or never did (`absent`). */
        runQuery: z.enum(["required", "absent"]).optional(),
        /**
         * Some panel links to `dashboard`, setting `variable` from one of
         * `columns` of the clicked row (#375).
         */
        link: z
          .object({
            dashboard: z.string().min(1),
            variable: z.string().min(1),
            columns: z.array(z.string()).min(1),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();
export type EvalCase = z.infer<typeof EvalCase>;

/** A model's answer to one case, as it streamed. */
export const Recording = z
  .object({
    /** The model that answered. */
    model: z.string(),
    recordedAt: z.string(),
    /**
     * A digest of the request (system and user prompt, schema name) the answer
     * was given to. When the prompt has changed since, the recording still
     * grades, but it no longer says how the current prompt does.
     */
    requestDigest: z.string(),
    text: z.string(),
    /** A chat turn's steps (#416), which replay plays back in order. */
    steps: z.array(ChatStep).optional(),
  })
  .strict();
export type Recording = z.infer<typeof Recording>;

export interface CaseResult {
  name: string;
  ok: boolean;
  failures: string[];
  /** Set in replay when the recording was made against a different prompt. */
  stale?: boolean;
  /** The raw answer, for recording. */
  text: string;
  /**
   * The model call finished. False for a provider error or a timeout, whose
   * partial text is not an answer and must never be recorded as one.
   */
  completed: boolean;
  model: string;
  requestDigest: string;
  /** A chat turn's steps, for recording. */
  steps?: ChatStep[];
}

export function loadCases(dir: string = EVALS_DIR): EvalCase[] {
  const corpus = join(dir, "corpus");
  return readdirSync(corpus)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => {
      const parsed = EvalCase.parse(JSON.parse(readFileSync(join(corpus, file), "utf8")));
      if (`${parsed.name}.json` !== file) {
        throw new Error(`evals/corpus/${file}: "name" must match the file name`);
      }
      return parsed;
    });
}

/** The case's catalog as a registered, refreshed source, the way a route sees one. */
export function loadSource(catalog: string, dir: string = EVALS_DIR): SourceRecord {
  const config = SourceConfigSchema.parse(
    JSON.parse(readFileSync(join(dir, "catalogs", `${catalog}.json`), "utf8")),
  );
  const at = "2026-01-01T00:00:00.000Z";
  return {
    id: `eval-${catalog}`,
    workspaceId: "eval",
    name: catalog,
    kind: config.kind,
    config,
    // A Prometheus catalog with no auth names no reference (#385).
    secretRef: "auth" in config && config.auth === "none" ? null : "TS_METRICS",
    catalogRefreshedAt: at,
    catalogMissingTables: [],
    createdBy: "eval",
    createdAt: at,
    updatedAt: at,
    tombstonedAt: null,
  };
}

export function loadRecording(name: string, dir: string = EVALS_DIR): Recording | null {
  try {
    return Recording.parse(
      JSON.parse(readFileSync(join(dir, "recordings", `${name}.json`), "utf8")),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** The request the route would make for this case. */
export function caseRequest(c: EvalCase, source: SourceRecord) {
  return c.mode === "dashboard"
    ? dashboardRequest({ source, prompt: c.prompt, dashboards: c.dashboards ?? [] })
    : explorePanelRequest({ source, prompt: c.prompt });
}

export function requestDigest(request: {
  system: string;
  prompt: string;
  schemaName: string;
}): string {
  // The catalog is fenced with a fresh random token on every call
  // (`fenceUntrustedBlock`); the same prompt must hash the same.
  const stable = (text: string) =>
    text.replace(/(===== (?:BEGIN|END) [A-Z_]+ )[0-9a-f]{32}( =====)/g, "$1<token>$2");
  return createHash("sha256")
    .update(`${request.schemaName}\n${stable(request.system)}\n${stable(request.prompt)}`)
    .digest("hex");
}

/**
 * A model that answers with `text`, streamed in a few pieces, as a recording
 * plays back. It reports the recorded model's id.
 */
export function replayModel(recording: Recording): LanguageModel {
  if (recording.steps) return chatReplayModel(recording.model, recording.steps);
  type V4 = Extract<LanguageModel, { specificationVersion: "v4" }>;
  type Part =
    Awaited<ReturnType<V4["doStream"]>>["stream"] extends ReadableStream<infer P>
      ? P
      : never;
  const usage = {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  };
  const model: V4 = {
    specificationVersion: "v4",
    provider: "replay",
    modelId: recording.model,
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error("replay supports streaming only")),
    async doStream() {
      const { text } = recording;
      const size = Math.max(1, Math.ceil(text.length / 4));
      const parts: Part[] = [
        { type: "stream-start", warnings: [] },
        {
          type: "response-metadata",
          id: "replay",
          modelId: recording.model,
          timestamp: new Date(0),
        },
        { type: "text-start", id: "t" },
      ];
      for (let i = 0; i < text.length; i += size) {
        parts.push({ type: "text-delta", id: "t", delta: text.slice(i, i + size) });
      }
      parts.push(
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
      );
      return {
        stream: new ReadableStream<Part>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
  return model;
}

/** Run one case against `model` and grade the answer. */
export async function runCase(
  c: EvalCase,
  source: SourceRecord,
  model: LanguageModel,
): Promise<CaseResult> {
  if (c.mode === "chat") return runChatCase(c, source, model);
  const request = caseRequest(c, source);
  const digest = requestDigest(request);
  let modelId = "";
  // A failed provider call arrives here and nowhere else: the SDK never
  // settles `result.object` for it, so awaiting that would hang the run.
  let streamError: unknown;
  const settings = {
    model,
    maxRetries: 0,
    // What every app call carries (#336); without it an OpenAI model is
    // measured refusing a schema the app never sends it strict.
    providerOptions: PROVIDER_OPTIONS,
    onFinish: (event: { response: { modelId?: string } }) => {
      modelId = event.response.modelId ?? "";
    },
    onError: ({ error }: { error: unknown }) => {
      streamError ??= error;
    },
  };
  // One call per mode: `streamObject` infers its output from the schema, and
  // a union of the two requests has no single schema to infer from.
  const result =
    c.mode === "dashboard"
      ? streamObject({ ...settings, ...(request as ReturnType<typeof dashboardRequest>) })
      : streamObject({
          ...settings,
          ...(request as ReturnType<typeof explorePanelRequest>),
        });
  let text = "";
  for await (const delta of result.textStream) text += delta;
  let object: unknown;
  let error: unknown = streamError;
  if (streamError === undefined) {
    try {
      object = await result.object;
    } catch (err) {
      error = err;
    }
  }
  const failures =
    object === undefined
      ? [await schemaFailure(error, request.schema)]
      : await grade(c, source, object as GradedOutput);
  return {
    name: c.name,
    ok: failures.length === 0,
    failures,
    text,
    model: modelId,
    completed: streamError === undefined,
    requestDigest: digest,
  };
}

/**
 * One Chat case: the turn through the real engine, graded on what the server
 * drew and whether it fetched rows in words. A refused panel is a failure,
 * as it would be a failed answer.
 */
async function runChatCase(
  c: EvalCase,
  source: SourceRecord,
  model: LanguageModel,
): Promise<CaseResult> {
  const request = chatRequest(source, c.prompt);
  const turn = await runChatTurn(source, c.prompt, model);
  const failures: string[] = [];
  if (!turn.completed) {
    failures.push(
      `no output: ${turn.error instanceof Error ? turn.error.message : String(turn.error)}`,
    );
  }
  for (const r of turn.refused) failures.push(`a panel was refused: ${r.error}`);
  // The per-panel checks, then the turn's own: the count and the words.
  const { minPanels, maxPanels, runQuery, tables, metrics, requiredViz, ...perPanel } =
    c.expect;
  for (const panel of turn.drawn) {
    failures.push(...(await grade({ ...c, expect: perPanel }, source, panel)));
  }
  failures.push(
    ...(await grade(
      { ...c, expect: { tables, metrics, requiredViz } },
      source,
      { panels: turn.drawn } as GradedOutput,
      { skipSave: true },
    )),
  );
  const n = turn.drawn.length;
  if (minPanels !== undefined && n < minPanels) {
    failures.push(`drew ${n} panels; expected at least ${minPanels}`);
  }
  if (maxPanels !== undefined && n > maxPanels) {
    failures.push(`drew ${n} panels; expected at most ${maxPanels}`);
  }
  if (runQuery === "required" && turn.runQueries === 0) {
    failures.push("never fetched rows with runQuery");
  } else if (runQuery === "absent" && turn.runQueries > 0) {
    failures.push(`fetched rows with runQuery ${turn.runQueries} time(s)`);
  }
  return {
    name: c.name,
    ok: failures.length === 0,
    failures,
    text: turn.text,
    steps: turn.steps,
    model: turn.modelId,
    completed: turn.completed,
    requestDigest: requestDigest(request),
  };
}

async function schemaFailure(error: unknown, schema: z.ZodType): Promise<string> {
  const failure = await describeFailure(error, schema);
  if (failure) return `does not match the schema: ${failure.issues.join("; ")}`;
  return `no output: ${error instanceof Error ? error.message : String(error)}`;
}

/** A generated dashboard (without `specVersion`), or one explore panel. */
type GradedOutput = { panels: Panel[] } | Panel;

/** Checks 2–4 on output that already parsed. Returns the failures, if any. */
/** A panel whose query is SQL. */
type SqlPanel = QueryPanel & { query: SqlQuery };
/** A panel whose query is PromQL (#387). */
type PromqlPanel = QueryPanel & { query: PromqlQuery };

/** Series names a counter-only function may be taken over: counters, and a histogram's or summary's totals. */
function isCounterLike(name: string, type: string | undefined): boolean {
  if (type === "counter") return true;
  return (
    (type === "histogram" || type === "summary") && /_(bucket|count|sum)$/.test(name)
  );
}

/** `rate()`, `irate()` and `increase()` over a metric that is not a counter. */
function rateOverNonCounters(promql: string, source: SourceRecord): string[] {
  const parsed = parsePromql(promql);
  if (!parsed.ok || !("metrics" in source.config)) return [];
  const types = new Map(source.config.metrics.map((m) => [m.name, m.type]));
  const found: string[] = [];
  for (const { node } of nodes(parsed.root)) {
    if (node.type !== "FunctionCall") continue;
    const fn = node.children[0]?.children[0]?.type;
    if (fn !== "Rate" && fn !== "Irate" && fn !== "Increase") continue;
    const body = node.children.find((c) => c.type === "FunctionCallBody");
    if (!body) continue;
    for (const selector of selectorsOf(promql, body)) {
      if (!isCounterLike(selector.metric, types.get(selector.metric))) {
        found.push(
          `${nodeText(promql, node.children[0])}() over ${selector.metric}, a ${types.get(selector.metric) ?? "unknown"}`,
        );
      }
    }
  }
  return found;
}

export async function grade(
  c: EvalCase,
  source: SourceRecord,
  output: GradedOutput,
  /** For a chat turn's panels, which were each checked already and are on no dashboard. */
  opts: { skipSave?: boolean } = {},
): Promise<string[]> {
  const failures: string[] = [];
  const panels = "panels" in output ? output.panels : [output];
  const queried = panels.filter(hasQuery);
  const sqlPanels = queried.filter((p): p is SqlPanel => isSqlQuery(p.query));
  const promqlPanels = queried.filter((p): p is PromqlPanel => isPromqlQuery(p.query));

  // 2. The guard, as a save would run it: the source's kind checks each
  // panel's language first, so SQL against a Prometheus source fails here.
  if (opts.skipSave) {
    // Each panel was held to the guard on its own.
  } else if ("panels" in output) {
    try {
      const spec = Dashboard.parse({ ...output, specVersion: SPEC_VERSION });
      await resolveAndValidateDashboard(spec, async (id) =>
        id === source.id ? source : null,
      );
    } catch (err) {
      failures.push(
        `rejected on save: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    for (const panel of queried) {
      if (panel.query.sourceId !== source.id) {
        failures.push(`panel "${panel.id}" names source "${panel.query.sourceId}"`);
      }
      const check = await serverKind(source).check(
        source,
        panel.query,
        declaredVariables({}),
      );
      if (!check.ok) failures.push(`panel "${panel.id}": ${check.error}`);
    }
  }

  // 3. The time field is a column the query returns (SQL); a counter is
  // taken through rate() and nothing else is (PromQL).
  for (const panel of sqlPanels) {
    const warning = timeFieldWarning(
      panel.query.timeField,
      selectOutputs(panel.query.sql),
    );
    if (warning) failures.push(`panel "${panel.id}": ${warning}`);
  }
  for (const panel of promqlPanels) {
    for (const problem of rateOverNonCounters(panel.query.promql, source)) {
      failures.push(`panel "${panel.id}": ${problem}`);
    }
  }

  // 4. The case's expectations.
  const { expect } = c;
  if (expect.plausibleViz) {
    for (const panel of queried) {
      if (!expect.plausibleViz.includes(panel.viz)) {
        failures.push(
          `panel "${panel.id}" is a ${panel.viz}; expected one of ${expect.plausibleViz.join(", ")}`,
        );
      }
    }
  }
  for (const viz of expect.requiredViz ?? []) {
    if (!panels.some((p) => p.viz === viz)) failures.push(`no ${viz} panel`);
  }
  if (expect.tables) {
    const read = new Set<string>();
    for (const panel of sqlPanels) {
      const analyzed = await analyzeSelect(panel.query.sql);
      if (analyzed.ok) for (const t of analyzed.analysis.tables) read.add(t.name);
    }
    for (const table of expect.tables) {
      if (!read.has(table)) failures.push(`no panel reads ${table}`);
    }
  }
  if (expect.metrics) {
    const named = new Set<string>();
    for (const panel of promqlPanels) {
      const parsed = parsePromql(panel.query.promql);
      if (!parsed.ok) continue;
      try {
        for (const s of selectorsOf(panel.query.promql, parsed.root)) named.add(s.metric);
      } catch {
        // A selector the guard refuses was already reported in step 2.
      }
    }
    for (const metric of expect.metrics) {
      if (!named.has(metric)) failures.push(`no panel reads ${metric}`);
    }
  }
  if (expect.timeField) {
    // A PromQL range query's rows carry "time"; an instant one has none.
    for (const panel of queried) {
      const field = queryTimeField(panel.query);
      if (expect.timeField === "required" && field === undefined) {
        failures.push(`panel "${panel.id}" has no timeField`);
      } else if (expect.timeField === "absent" && field !== undefined) {
        failures.push(`panel "${panel.id}" sets timeField "${field}"`);
      }
    }
  }
  if (expect.minPanels !== undefined && panels.length < expect.minPanels) {
    failures.push(`${panels.length} panels; expected at least ${expect.minPanels}`);
  }
  if (expect.maxPanels !== undefined && panels.length > expect.maxPanels) {
    failures.push(`${panels.length} panels; expected at most ${expect.maxPanels}`);
  }
  if (expect.link) {
    const want = expect.link;
    const found = panels.some((p) =>
      (p.links ?? []).some((l) => {
        const pick = l.set?.[want.variable];
        return (
          l.dashboard === want.dashboard &&
          pick !== undefined &&
          "column" in pick &&
          want.columns.includes(pick.column)
        );
      }),
    );
    if (!found) {
      failures.push(
        `no panel links to ${want.dashboard} setting ${want.variable} from column ${want.columns.join(" or ")}`,
      );
    }
  }
  return failures;
}
