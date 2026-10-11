import { audit } from "@/lib/audit";
import { requireIdentity } from "@/lib/auth/authorize";
import { ModelInput } from "@/lib/ai/model-config";
import {
  assertManages,
  createModel,
  modelAuditDetail,
  workspaceModelView,
  workspaceOf,
  workspaceOwner,
} from "@/lib/ai/model-admin";
import { json, readJson, route } from "@/lib/http";

export const runtime = "nodejs";

/**
 * A workspace's models (#439), for whoever holds `source:manage` there:
 * every model, the default and the personal-keys toggle, each model with
 * its settings and the credentials' state, never the credentials.
 */
export const GET = route(
  "workspaces.models.list",
  async (_req: Request, ctx: RouteContext<"/api/workspaces/[id]/models">) => {
    const identity = await requireIdentity();
    const workspaceId = workspaceOf((await ctx.params).id);
    assertManages(identity, workspaceId);
    return json(await workspaceModelView(workspaceId));
  },
);

/** Add a model to the workspace. Refused in demo mode. */
export const POST = route(
  "workspaces.models.create",
  async (req: Request, ctx: RouteContext<"/api/workspaces/[id]/models">) => {
    const identity = await requireIdentity();
    const workspaceId = workspaceOf((await ctx.params).id);
    assertManages(identity, workspaceId);
    const body = await readJson(req, ModelInput, { maxBytes: 16_384 });
    const created = await createModel(workspaceOwner(workspaceId), body, identity.sub);
    audit({
      actor: identity,
      action: "workspace.model.create",
      workspaceId,
      resource: { type: "model", id: created.id },
      detail: modelAuditDetail(body),
    });
    return json(created, { status: 201 });
  },
);
