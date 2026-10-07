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

/**
 * "Test connection" for a workspace's model (#331): one minimal call with the
 * configuration in the form, saved or not, and the stored key when the form
 * left it out. Admitted by the workspace's rate limit and budget like a
 * generation. Answers 200 either way; `ok` says whether the model answered,
 * and `message` why not, in words that never carry the key.
 */
export const POST = route(
  "workspaces.model.test",
  async (req: Request, ctx: RouteContext<"/api/workspaces/[id]/model/test">) => {
    const identity = await requireIdentity();
    const parsed = WorkspaceId.safeParse((await ctx.params).id);
    if (!parsed.success) throw new HttpError(400, "invalid workspace id");
    const workspaceId = parsed.data;
    assertAuthorized(
      identity,
      "source:manage",
      { workspaceId },
      { type: "workspace", id: workspaceId },
    );
    const deps = defaultModelDeps();
    assertConfigurable(deps);
    const body = await readJson(req, ModelConfigInput, { maxBytes: 16_384 });
    const current = await deps.store.workspace(workspaceId);
    const model = await modelForTest(body, current?.config ?? null, deps);
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
        baseUrlHost: new URL(body.settings.baseUrl).host,
        model: body.settings.model,
      },
    });
    return json(result);
  },
);
