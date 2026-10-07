import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireIdentity, assertAuthorized, HttpError } from "@/lib/auth/authorize";
import { readJson, route } from "@/lib/http";
import { audit } from "@/lib/audit";
import { getSourceById } from "@/lib/db/repo";
import {
  streamDashboard,
  streamDashboardRefinement,
  streamPanel,
  streamExplorePanel,
  type OnGenerationFinish,
} from "@/lib/ai/generate";
import { catalogHealth, catalogRefusal } from "@/lib/catalog/health";
import { recordGeneration } from "@/lib/ai/log";
import { textResponseOnceStarted } from "@/lib/ai/provider-error";
import {
  type Failure,
  GENERATION_ID_HEADER,
  NOTHING_TO_REPAIR,
  rememberFailure,
  takeFailure,
} from "@/lib/ai/repair";
import { recordLlmRepair } from "@/lib/metrics";
import { buildCatalogPrompt } from "@/lib/timescaledb/catalog";
import { enforceLlmLimits } from "@/lib/limits/llm";
import { Panel } from "@/lib/ir";
import { StoredDashboard } from "@/lib/ir/upgrade";
import { log } from "@/lib/log";
import { workspacePromptFor } from "@/lib/workspace-prompt-service";

export const runtime = "nodejs";
export const maxDuration = 60;

const GenerateBody = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("dashboard"),
    sourceId: z.string().min(1),
    prompt: z.string().min(1).max(4000),
  }),
  z.object({
    mode: z.literal("dashboard-refine"),
    sourceId: z.string().min(1),
    prompt: z.string().min(1).max(4000),
    // A tab opened before a deploy sends the spec it has; upgrade it (#58).
    current: StoredDashboard,
  }),
  z.object({
    mode: z.literal("panel"),
    sourceId: z.string().min(1),
    prompt: z.string().min(1).max(4000),
    current: Panel,
  }),
  z.object({
    mode: z.literal("explore"),
    sourceId: z.string().min(1),
    prompt: z.string().min(1).max(4000),
  }),
]);
type GenerateBody = z.infer<typeof GenerateBody>;

/**
 * The one automatic repair of a generation whose output failed its schema
 * (#21). It names the failed generation and nothing else: the request it
 * repeats, and what was wrong, come from the server's own record.
 */
const RepairBody = z.object({ repairOf: z.uuid() }).strict();

const Body = z.union([RepairBody, GenerateBody]);

/**
 * Generate a dashboard/panel spec via the LLM. Runs the model exactly once, or
 * for `{ repairOf }` once more to repair a first attempt that failed its schema
 * (#21), from the server's own record of that attempt.
 * Authorization: editor on the workspace that OWNS the selected source (the
 * workspace is derived from the trusted source record, never from the request).
 * Then the catalog is checked, and the workspace's rate limit and token budget
 * are enforced; over either, the request is refused with 429 before the model
 * is called.
 *
 * The catalog check comes before the limits deliberately: a source whose
 * tables were never verified cannot produce working SQL, and spending a
 * workspace's rate allowance to be told so is the wrong order. The refusal is
 * a 400 that names the source and the fix.
 */
export const POST = route("generate", async (req: Request) => {
  const identity = await requireIdentity();
  const input = await readJson(req, Body);

  // A repair replays the original request from the store; everything below,
  // authorization and the limits included, runs again for it as for any other.
  let body: GenerateBody;
  let repair: Failure | undefined;
  if ("repairOf" in input) {
    const pending = takeFailure<GenerateBody>(input.repairOf, identity.sub, "generate");
    if (!pending) throw new HttpError(404, NOTHING_TO_REPAIR);
    body = pending.request;
    repair = pending.failure;
  } else {
    body = input;
  }

  const source = await getSourceById(body.sourceId);
  if (!source || source.tombstonedAt) {
    throw new HttpError(400, "unknown or removed source");
  }

  assertAuthorized(
    identity,
    "dashboard:generate",
    { workspaceId: source.workspaceId },
    { type: "source", id: source.id },
  );

  const refusal = catalogRefusal(source, catalogHealth(source));
  if (refusal) throw new HttpError(400, refusal);

  const usage = await enforceLlmLimits({
    identity,
    workspaceId: source.workspaceId,
    route: "generate",
  });

  // The workspace's own context (#66), from the workspace that owns the
  // trusted source record. Advisory: if it cannot be read, the generation
  // runs on the base prompt rather than failing.
  const workspacePrompt = await workspacePromptFor(source).catch((error: unknown) => {
    log.warn("workspace_prompt.load_failed", { workspaceId: source.workspaceId, error });
    return null;
  });

  // What the model is about to be shown, so the log can say which catalog was
  // in context without keeping the text. Built here rather than handed back by
  // the stream: it is a pure function of the same trusted source record.
  const catalog = buildCatalogPrompt(source);
  // Only a first attempt can be repaired, so only it gets an id.
  const generationId = repair ? null : randomUUID();
  const onFinish: OnGenerationFinish = (event) => {
    usage.record(event.usage);
    const ok = !event.error && event.object !== undefined;
    if (repair) recordLlmRepair("generate", ok ? "repaired" : "failed");
    // Held before the stream closes: onFinish runs ahead of the browser
    // seeing the end, so the repair request it triggers finds the entry.
    if (generationId && event.failure) {
      rememberFailure(generationId, {
        sub: identity.sub,
        route: "generate",
        request: body,
        failure: event.failure,
      });
    }
    recordGeneration({
      workspaceId: source.workspaceId,
      createdBy: identity.sub,
      mode: body.mode,
      sourceId: source.id,
      prompt: body.prompt,
      catalog,
      spec: event.object,
      model: event.modelId,
      usage: event.usage,
      attempts: repair ? 2 : 1,
      error: event.error,
    });
    // The generation log keeps the redacted prompt and the spec; the audit
    // row says who asked and how it went, with the prompt as a digest.
    audit({
      actor: identity,
      action: "dashboard.generate",
      workspaceId: source.workspaceId,
      resource: { type: "source", id: source.id },
      outcome: event.error || !event.object ? "failure" : "success",
      detail: {
        mode: body.mode,
        prompt: body.prompt,
        model: event.modelId,
        ...(repair ? { attempt: 2 } : {}),
      },
    });
  };

  // A ternary rather than `let result` + if/else: the latter gives `result`
  // an implicit `any`, which loses the streamObject result type here.
  const result =
    body.mode === "dashboard"
      ? streamDashboard({
          source,
          prompt: body.prompt,
          workspacePrompt,
          onFinish,
          repair,
        })
      : body.mode === "dashboard-refine"
        ? streamDashboardRefinement({
            source,
            prompt: body.prompt,
            current: body.current,
            workspacePrompt,
            onFinish,
            repair,
          })
        : body.mode === "explore"
          ? streamExplorePanel({
              source,
              prompt: body.prompt,
              workspacePrompt,
              onFinish,
              repair,
            })
          : streamPanel({
              source,
              prompt: body.prompt,
              current: body.current,
              workspacePrompt,
              onFinish,
              repair,
            });

  // A provider that refused the request answers here, as an error that names
  // the setting to fix, rather than as an empty 200 (#337).
  return textResponseOnceStarted(
    result,
    generationId ? { [GENERATION_ID_HEADER]: generationId } : undefined,
  );
});
