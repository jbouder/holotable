import { audit } from "@/lib/audit";
import { requireIdentity } from "@/lib/auth/authorize";
import { WorkspaceModelInput } from "@/lib/ai/model-config";
import {
  assertManages,
  saveWorkspaceModelSettings,
  workspaceModelView,
  workspaceOf,
} from "@/lib/ai/model-admin";
import { defaultModelDeps } from "@/lib/ai/model-resolution";
import { json, readJson, route } from "@/lib/http";

export const runtime = "nodejs";

/**
 * A workspace's model settings (#331, #439), for whoever holds
 * `source:manage` there: its models, which one a generation uses when
 * nobody picks, and whether people may use their own models here. Never a
 * credential.
 */
export const GET = route(
  "workspaces.model.get",
  async (_req: Request, ctx: RouteContext<"/api/workspaces/[id]/model">) => {
    const identity = await requireIdentity();
    const workspaceId = workspaceOf((await ctx.params).id);
    assertManages(identity, workspaceId);
    return json(await workspaceModelView(workspaceId));
  },
);

/**
 * Set the default (a workspace model's id, a server model's `env:<name>`,
 * or null for the server's default) and the personal-models toggle. Takes
 * effect on the next generation: resolution reads the row every time.
 */
export const PUT = route(
  "workspaces.model.update",
  async (req: Request, ctx: RouteContext<"/api/workspaces/[id]/model">) => {
    const identity = await requireIdentity();
    const workspaceId = workspaceOf((await ctx.params).id);
    assertManages(identity, workspaceId);
    const deps = defaultModelDeps();
    const body = await readJson(req, WorkspaceModelInput, { maxBytes: 4_096 });
    const before = await deps.store.workspace(workspaceId);
    const view = await saveWorkspaceModelSettings(workspaceId, body, identity.sub, deps);
    audit({
      actor: identity,
      action: "workspace.model.update",
      workspaceId,
      resource: { type: "workspace", id: workspaceId },
      detail: {
        defaultModel: body.defaultModel,
        previousDefault: before?.defaultModel ?? null,
        allowPersonalKeys: body.allowPersonalKeys,
      },
    });
    return json(view);
  },
);
