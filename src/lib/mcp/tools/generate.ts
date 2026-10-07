import { NoObjectGeneratedError } from "ai";
import { z } from "zod";
import type { GenerationFinish, OnGenerationFinish } from "@/lib/ai/generate";
import type { GenerationMode } from "@/lib/ai/log";
import { providerHttpError } from "@/lib/ai/provider-error";
import type { Failure } from "@/lib/ai/repair";
import { audit } from "@/lib/audit";
import { assertAuthorized, HttpError } from "@/lib/auth/authorize";
import type { Identity } from "@/lib/auth/claims";
import { AdditionalSourceIds, resolveGenerationSources } from "@/lib/generation-sources";
import { DashboardGenerationSchema, ExplorePanel, fromGenerated } from "@/lib/ir";
import { ModelSourceDraft } from "@/lib/registry";
import type { LlmRoute } from "@/lib/limits/budget";
import { log } from "@/lib/log";
import { defineTool, type McpTool, type McpToolAnnotations } from "@/lib/mcp/tool";
import type { McpDeps } from "@/lib/mcp/tools/deps";
import { recordLlmRepair } from "@/lib/metrics";
import { grantedRefs } from "@/lib/secret-refs";
import { buildCatalogPrompt } from "@/lib/timescaledb/catalog";

/**
 * The generation flows, as tools. Each is the route it mirrors —
 * `POST /api/generate` in `dashboard` and `explore` mode, and
 * `POST /api/sources/generate` — with the same source resolution, the same
 * `dashboard:generate` / `source:manage` check, the same rate limit and
 * budget (#18), the same generation-log row and the same audit row. The
 * result is a spec, never data: a dashboard to hand to `save_dashboard`, a
 * panel to put in one, or a source draft to register in the app.
 *
 * One difference in shape. The routes stream the object to a browser and
 * leave the one repair (#21) to a follow-up request from it; a tool call
 * answers once, so the stream is consumed here and a schema failure is
 * repaired inline, with the second model call counted, limited and recorded
 * exactly as the browser's follow-up would be.
 */

const GENERATES: McpToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  // The model is outside this server.
  openWorldHint: true,
};

const Prompt = z
  .string()
  .min(1)
  .max(4000)
  .describe("What the dashboard or panel should show, in plain English.");

/** What the stream functions return, as far as this module reads it. */
interface StreamResult<T> {
  fullStream: ReadableStream<{ type: string; error?: unknown }>;
  object: Promise<T>;
}

/**
 * Read a stream to its end and return the object. A provider refusing the
 * request arrives as an `error` part (#337) and becomes the error that names
 * the setting to fix; an answer that failed the schema is left to `object`
 * to reject with, so the caller can repair it.
 */
async function settle<T>(result: StreamResult<T>): Promise<T> {
  const reader = result.fullStream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.type === "error" && !NoObjectGeneratedError.isInstance(value.error)) {
      reader.cancel().catch(() => {});
      throw providerHttpError(value.error);
    }
  }
  return result.object;
}

interface Generation<T> {
  identity: Identity;
  workspaceId: string;
  route: LlmRoute;
  mode: GenerationMode;
  sourceId: string | null;
  prompt: string;
  catalog: string | null;
  /** The audit row for one attempt. */
  auditAttempt: (event: GenerationFinish, attempt: number) => void;
  /** Start one model call. */
  start: (opts: { onFinish: OnGenerationFinish; repair?: Failure }) => StreamResult<T>;
}

/** Up to two model calls: the generation, and one repair when it failed the schema. */
async function generate<T>(deps: McpDeps, input: Generation<T>): Promise<T> {
  const { identity, workspaceId, route, mode } = input;
  let repair: Failure | undefined;
  for (let attempt = 1; ; attempt++) {
    // Every call is admitted on its own, the repair included.
    const usage = await deps.enforceLlmLimits({ identity, workspaceId, route });
    let finished: GenerationFinish | undefined;
    const result = input.start({
      repair,
      onFinish: (event) => {
        finished = event;
        usage.record(event.usage);
        const ok = !event.error && event.object !== undefined;
        if (repair) recordLlmRepair(route, ok ? "repaired" : "failed");
        deps.recordGeneration({
          workspaceId,
          createdBy: identity.sub,
          mode,
          sourceId: input.sourceId,
          prompt: input.prompt,
          catalog: input.catalog,
          spec: event.object,
          model: event.modelId,
          usage: event.usage,
          attempts: attempt,
          error: event.error,
        });
        input.auditAttempt(event, attempt);
      },
    });
    try {
      return await settle(result);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const failure = finished?.failure ?? null;
      if (attempt === 1 && failure) {
        log.info("mcp.generation_repair", { mode, issues: failure.issues.length });
        repair = failure;
        continue;
      }
      throw new HttpError(
        502,
        failure
          ? `the model's answer did not match the schema: ${failure.issues.join("; ")}`
          : "the model produced no answer",
      );
    }
  }
}

export function generationTools(deps: McpDeps): McpTool[] {
  return [
    defineTool({
      name: "generate_dashboard",
      title: "Generate a dashboard",
      description:
        "Ask the model for a complete dashboard spec from a description, against one source (and up to two more from the same workspace). Every panel's SQL is already validated against the guard. Returns the spec, not data: review it, adjust it, then save_dashboard. Counts against the workspace's model rate limit and daily budget.",
      input: z.object({
        sourceId: z.string().min(1).describe("The primary source, from list_sources."),
        additionalSourceIds: AdditionalSourceIds.optional().describe(
          "Other sources in the same workspace the dashboard may draw on.",
        ),
        prompt: Prompt,
      }),
      annotations: GENERATES,
      async run(args, { identity }) {
        const { source, additional } = await resolveGenerationSources({
          identity,
          sourceId: args.sourceId,
          additionalSourceIds: args.additionalSourceIds,
          getSource: deps.getSource,
        });
        const sources = [source, ...additional];
        const workspacePrompt = await deps
          .workspacePromptFor(sources)
          .catch((error: unknown) => {
            log.warn("workspace_prompt.load_failed", {
              workspaceId: source.workspaceId,
              error,
            });
            return null;
          });
        const catalog = sources.map((s) => buildCatalogPrompt(s)).join("\n\n");
        const generated = await generate(deps, {
          identity,
          workspaceId: source.workspaceId,
          route: "generate",
          mode: "dashboard",
          sourceId: source.id,
          prompt: args.prompt,
          catalog,
          auditAttempt: (event, attempt) =>
            audit({
              actor: identity,
              action: "dashboard.generate",
              workspaceId: source.workspaceId,
              resource: { type: "source", id: source.id },
              outcome: event.error || !event.object ? "failure" : "success",
              detail: {
                mode: "dashboard",
                prompt: args.prompt,
                model: event.modelId,
                via: "mcp",
                ...(additional.length > 0 ? { sourceIds: sources.map((s) => s.id) } : {}),
                ...(attempt > 1 ? { attempt } : {}),
              },
            }),
          start: ({ onFinish, repair }) =>
            deps.streamDashboard({
              source,
              additionalSources: additional,
              prompt: args.prompt,
              workspacePrompt,
              onFinish,
              repair,
            }),
        });
        // Validated by the stream already; parsed again to be typed, not trusted less.
        return { spec: fromGenerated(DashboardGenerationSchema.parse(generated)) };
      },
    }),

    defineTool({
      name: "generate_panel",
      title: "Generate a panel",
      description:
        "Ask the model for one panel spec that answers a question against a source: the viz kind, its SQL (validated against the guard) and its options. Returns the panel, not data; put it in a dashboard spec and save_dashboard. Counts against the workspace's model rate limit and daily budget.",
      input: z.object({
        sourceId: z.string().min(1).describe("The source, from list_sources."),
        prompt: Prompt,
      }),
      annotations: GENERATES,
      async run(args, { identity }) {
        const { source } = await resolveGenerationSources({
          identity,
          sourceId: args.sourceId,
          getSource: deps.getSource,
        });
        const workspacePrompt = await deps
          .workspacePromptFor([source])
          .catch((error: unknown) => {
            log.warn("workspace_prompt.load_failed", {
              workspaceId: source.workspaceId,
              error,
            });
            return null;
          });
        const panel = await generate(deps, {
          identity,
          workspaceId: source.workspaceId,
          route: "generate",
          mode: "explore",
          sourceId: source.id,
          prompt: args.prompt,
          catalog: buildCatalogPrompt(source),
          auditAttempt: (event, attempt) =>
            audit({
              actor: identity,
              action: "dashboard.generate",
              workspaceId: source.workspaceId,
              resource: { type: "source", id: source.id },
              outcome: event.error || !event.object ? "failure" : "success",
              detail: {
                mode: "explore",
                prompt: args.prompt,
                model: event.modelId,
                via: "mcp",
                ...(attempt > 1 ? { attempt } : {}),
              },
            }),
          start: ({ onFinish, repair }) =>
            deps.streamExplorePanel({
              source,
              prompt: args.prompt,
              workspacePrompt,
              onFinish,
              repair,
            }),
        });
        return { panel: ExplorePanel.parse(panel) };
      },
    }),

    defineTool({
      name: "generate_source",
      title: "Draft a data source",
      description:
        "Ask the model to draft a data-source registration from a description: the safe connection config (host, port, database, schema) and a best-effort table catalog, naming one of the workspace's granted secret references for the credentials. Never credentials, never live data. The draft is registered, tested and its catalog refreshed in the app; no tool creates a source. Needs source-admin in the workspace.",
      input: z.object({
        workspaceId: z.string().min(1).max(128),
        prompt: z
          .string()
          .min(1)
          .max(4000)
          .describe("The database and what it holds, in plain English."),
      }),
      annotations: GENERATES,
      async run(args, { identity }) {
        assertAuthorized(identity, "source:manage", { workspaceId: args.workspaceId });
        const draft = await generate(deps, {
          identity,
          workspaceId: args.workspaceId,
          route: "source-draft",
          mode: "source-draft",
          sourceId: null,
          prompt: args.prompt,
          catalog: null,
          auditAttempt: (event, attempt) =>
            audit({
              actor: identity,
              action: "source.draft",
              workspaceId: args.workspaceId,
              outcome: event.error || !event.object ? "failure" : "success",
              detail: {
                prompt: args.prompt,
                model: event.modelId,
                via: "mcp",
                ...(attempt > 1 ? { attempt } : {}),
              },
            }),
          start: ({ onFinish, repair }) =>
            deps.streamSourceDraft({
              prompt: args.prompt,
              grantedSecretRefs: grantedRefs(deps.secretRefGrants(), args.workspaceId),
              onFinish,
              repair,
            }),
        });
        return { draft: ModelSourceDraft.parse(draft) };
      },
    }),
  ];
}
