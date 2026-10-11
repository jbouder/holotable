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
export const maxDuration = 60;

/**
 * "Test connection" for a model not yet saved (#439): one minimal call with the configuration
 * in the form. Admitted by the workspace's rate limit and budget like
 * a generation. Answers 200 either way; `ok` says whether the model answered,
 * and `message` why not, in words that never carry a credential.
 */
export const POST = route(
  "workspaces.models.test",
  async (req: Request, ctx: RouteContext<"/api/workspaces/[id]/models/test">) => {
    const identity = await requireIdentity();
    const params = await ctx.params;
    const workspaceId = workspaceOf(params.id);
    assertManages(identity, workspaceId);
    const body = await readJson(req, ModelConfigInput, { maxBytes: 16_384 });
    const model = await modelToTest(workspaceOwner(workspaceId), body, null);
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
      resource: { type: "workspace", id: workspaceId },
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
