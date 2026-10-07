import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireIdentity, assertAuthorized, HttpError } from "@/lib/auth/authorize";
import { readJson, route } from "@/lib/http";
import { audit } from "@/lib/audit";
import { type OnGenerationFinish, streamSourceDraft } from "@/lib/ai/generate";
import { recordGeneration } from "@/lib/ai/log";
import { requireModel } from "@/lib/ai/model-resolution";
import { textResponseOnceStarted } from "@/lib/ai/provider-error";
import {
  type Failure,
  GENERATION_ID_HEADER,
  NOTHING_TO_REPAIR,
  rememberFailure,
  takeFailure,
} from "@/lib/ai/repair";
import { recordLlmRepair } from "@/lib/metrics";
import { enforceLlmLimits } from "@/lib/limits/llm";
import { grantedRefs } from "@/lib/secret-refs";
import { secretRefGrants } from "@/lib/secrets/credentials";

export const runtime = "nodejs";
export const maxDuration = 60;

const DraftBody = z.object({
  workspaceId: z.string().min(1).max(128),
  prompt: z.string().min(1).max(4000),
});
type DraftBody = z.infer<typeof DraftBody>;

/** The one automatic repair of a draft that failed its schema (#21). */
const RepairBody = z.object({ repairOf: z.uuid() }).strict();

const Body = z.union([RepairBody, DraftBody]);

/**
 * Draft a data source from natural language. Runs the model exactly once (plus
 * the one repair, #21, for `{ repairOf }`) and
 * streams back a SourceDraft (safe connection config + table catalog, never
 * credentials or data) for the user to review before creating it.
 *
 * Authorization mirrors source creation: source:manage on the target workspace,
 * which is taken from the request but validated against the caller's identity.
 * The workspace's rate limit and token budget are enforced after that check,
 * so the limits are keyed by a workspace the caller is already authorized in.
 */
export const POST = route("sources.draft", async (req: Request) => {
  const identity = await requireIdentity();
  const input = await readJson(req, Body);

  // A repair replays the original request from the store, and is authorized
  // and limited again like any other.
  let body: DraftBody;
  let repair: Failure | undefined;
  if ("repairOf" in input) {
    const pending = takeFailure<DraftBody>(input.repairOf, identity.sub, "source-draft");
    if (!pending) throw new HttpError(404, NOTHING_TO_REPAIR);
    body = pending.request;
    repair = pending.failure;
  } else {
    body = input;
  }

  assertAuthorized(identity, "source:manage", {
    workspaceId: body.workspaceId,
  });

  const resolved = await requireModel({ identity, workspaceId: body.workspaceId });

  const usage = await enforceLlmLimits({
    identity,
    workspaceId: body.workspaceId,
    route: "source-draft",
    model: resolved.modelId,
  });

  // A source description is the prompt most likely to contain a pasted
  // connection string, which is exactly what the log's redaction pass is for.
  // There is no source yet, so no catalog was in context.
  const generationId = repair ? null : randomUUID();
  const onFinish: OnGenerationFinish = (event) => {
    usage.record(event.usage);
    const ok = !event.error && event.object !== undefined;
    if (repair) recordLlmRepair("source-draft", ok ? "repaired" : "failed");
    if (generationId && event.failure) {
      rememberFailure(generationId, {
        sub: identity.sub,
        route: "source-draft",
        request: body,
        failure: event.failure,
      });
    }
    recordGeneration({
      workspaceId: body.workspaceId,
      createdBy: identity.sub,
      mode: "source-draft",
      sourceId: null,
      prompt: body.prompt,
      catalog: null,
      spec: event.object,
      model: event.modelId,
      modelConfig: resolved.source,
      usage: event.usage,
      attempts: repair ? 2 : 1,
      error: event.error,
    });
    audit({
      actor: identity,
      action: "source.draft",
      workspaceId: body.workspaceId,
      outcome: event.error || !event.object ? "failure" : "success",
      detail: {
        prompt: body.prompt,
        model: event.modelId,
        modelConfig: resolved.source,
        ...(repair ? { attempt: 2 } : {}),
      },
    });
  };

  const result = streamSourceDraft({
    prompt: body.prompt,
    grantedSecretRefs: grantedRefs(secretRefGrants(), body.workspaceId),
    onFinish,
    model: resolved.model,
    repair,
  });
  // A provider that refused the request answers here, as an error that names
  // the setting to fix, rather than as an empty 200 (#337).
  return textResponseOnceStarted(
    result,
    generationId ? { [GENERATION_ID_HEADER]: generationId } : undefined,
  );
});
