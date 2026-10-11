import { z } from "zod";
import { audit } from "@/lib/audit";
import { assertAuthorized, HttpError, requireIdentity } from "@/lib/auth/authorize";
import { ModelConfigInput } from "@/lib/ai/model-config";
import { modelToTest, personalOwner } from "@/lib/ai/model-admin";
import { defaultModelDeps } from "@/lib/ai/model-resolution";
import { testModel } from "@/lib/ai/model-test";
import { endpointHost } from "@/lib/ai/providers/registry";
import { json, readJson, route } from "@/lib/http";
import { enforceLlmLimits } from "@/lib/limits/llm";
import { WorkspaceId } from "@/lib/workspace-limits";

export const runtime = "nodejs";
export const maxDuration = 120;

const Body = z
  .object({
    config: ModelConfigInput,
    // The workspace whose rate limit and budget the call is admitted by: one
    // the caller generates in, and that allows personal models.
    workspaceId: WorkspaceId,
    // A saved model whose stored credentials stand in for blank fields.
    modelId: z.string().max(64).optional(),
  })
  .strict();

/**
 * "Test connection" for one of the caller's own models (#439), saved or
 * not, with the stored credentials when the form left them out (same origin
 * only). Answers 200 either way; `ok` says whether the model answered.
 */
export const POST = route("me.models.test", async (req: Request) => {
  const identity = await requireIdentity();
  const owner = personalOwner(identity);
  const deps = defaultModelDeps();
  const body = await readJson(req, Body, { maxBytes: 16_384 });
  const { workspaceId } = body;
  assertAuthorized(
    identity,
    "dashboard:generate",
    { workspaceId },
    { type: "workspace", id: workspaceId },
  );
  const workspace = await deps.store.workspace(workspaceId);
  if (!workspace?.allowPersonalKeys) {
    throw new HttpError(403, "This workspace does not allow personal models.");
  }
  const model = await modelToTest(owner, body.config, body.modelId ?? null, deps);
  const usage = await enforceLlmLimits({
    identity,
    workspaceId,
    route: "model-test",
    model: body.config.settings.model,
  });
  const result = await testModel(model, usage);
  audit({
    actor: identity,
    action: "user.model.test",
    workspaceId,
    outcome: result.ok ? "success" : "failure",
    detail: {
      provider: body.config.settings.provider,
      endpointHost: endpointHost(body.config.settings),
      model: body.config.settings.model,
    },
  });
  return json(result);
});
