import { audit } from "@/lib/audit";
import { requireIdentity } from "@/lib/auth/authorize";
import { ModelConfigInput } from "@/lib/ai/model-config";
import {
  assertManages,
  modelToTest,
  workspaceOf,
  workspaceOwner,
} from "@/lib/ai/model-admin";
import { testModel } from "@/lib/ai/model-test";
import { endpointHost } from "@/lib/ai/providers/registry";
import { json, readJson, route } from "@/lib/http";
import { enforceLlmLimits } from "@/lib/limits/llm";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * "Test connection" for one of the workspace's models (#439): one minimal call with the configuration
 * in the form, with the model's stored
 * credentials when the form left them out (same origin only). Admitted by the workspace's rate limit and budget like
 * a generation. Answers 200 either way; `ok` says whether the model answered,
 * and `message` why not, in words that never carry a credential.
 */
export const POST = route(
  "workspaces.models.test_saved",
  async (
    req: Request,
    ctx: RouteContext<"/api/workspaces/[id]/models/[modelId]/test">,
  ) => {
    const identity = await requireIdentity();
    const params = await ctx.params;
    const workspaceId = workspaceOf(params.id);
    assertManages(identity, workspaceId);
    const body = await readJson(req, ModelConfigInput, { maxBytes: 16_384 });
    const model = await modelToTest(workspaceOwner(workspaceId), body, params.modelId);
    const usage = await enforceLlmLimits({
      identity,
      workspaceId,
      route: "model-test",
      model: body.settings.model,
    });
    const result = await testModel(model, usage);
    audit({
      actor: identity,
      action: "workspace.model.test",
      workspaceId,
      resource: { type: "model", id: params.modelId },
      outcome: result.ok ? "success" : "failure",
      detail: {
        provider: body.settings.provider,
        endpointHost: endpointHost(body.settings),
        model: body.settings.model,
      },
    });
    return json(result);
  },
);
