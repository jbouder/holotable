import { z } from "zod";
import { audit } from "@/lib/audit";
import { assertAuthorized, HttpError, requireIdentity } from "@/lib/auth/authorize";
import { ModelConfigInput } from "@/lib/ai/model-config";
import {
  assertConfigurable,
  defaultModelDeps,
  modelForTest,
} from "@/lib/ai/model-resolution";
import { testModel } from "@/lib/ai/model-test";
import { json, readJson, route } from "@/lib/http";
import { enforceLlmLimits } from "@/lib/limits/llm";
import { WorkspaceId } from "@/lib/workspace-limits";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z
  .object({
    config: ModelConfigInput,
    // The workspace whose rate limit and budget the call is admitted by: one
    // the caller generates in, and that allows personal keys.
    workspaceId: WorkspaceId,
  })
  .strict();

/**
 * "Test connection" for a person's own model (#331), with the configuration
 * in the form and the stored key when the form left it out. Answers 200
 * either way; `ok` says whether the model answered.
 */
export const POST = route("me.model.test", async (req: Request) => {
  const identity = await requireIdentity();
  if (identity.serviceAccount) {
    throw new HttpError(403, "A service-account token has no personal model.");
  }
  const deps = defaultModelDeps();
  assertConfigurable(deps);
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
    throw new HttpError(403, "This workspace does not allow personal model keys.");
  }
  const current = await deps.store.user(identity.sub);
  const model = await modelForTest(body.config, current, deps);
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
      baseUrlHost: new URL(body.config.settings.baseUrl).host,
      model: body.config.settings.model,
    },
  });
  return json(result);
});
