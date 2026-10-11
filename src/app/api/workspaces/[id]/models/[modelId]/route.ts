import { audit } from "@/lib/audit";
import { requireIdentity } from "@/lib/auth/authorize";
import { ModelInput } from "@/lib/ai/model-config";
import {
  assertManages,
  deleteModel,
  modelAuditDetail,
  updateModel,
  workspaceOf,
  workspaceOwner,
} from "@/lib/ai/model-admin";
import { json, readJson, route } from "@/lib/http";

export const runtime = "nodejs";

/**
 * Replace one of the workspace's models (#439). Credentials left out are
 * kept, for the same origin only. Takes effect on the next generation.
 */
export const PUT = route(
  "workspaces.models.update",
  async (req: Request, ctx: RouteContext<"/api/workspaces/[id]/models/[modelId]">) => {
    const identity = await requireIdentity();
    const { id, modelId } = await ctx.params;
    const workspaceId = workspaceOf(id);
    assertManages(identity, workspaceId);
    const body = await readJson(req, ModelInput, { maxBytes: 16_384 });
    const updated = await updateModel(
      workspaceOwner(workspaceId),
      modelId,
      body,
      identity.sub,
    );
    audit({
      actor: identity,
      action: "workspace.model.update",
      workspaceId,
      resource: { type: "model", id: updated.id },
      detail: modelAuditDetail(body),
    });
    return json(updated);
  },
);

/** Delete one of the workspace's models; deleting the default clears it. */
export const DELETE = route(
  "workspaces.models.delete",
  async (_req: Request, ctx: RouteContext<"/api/workspaces/[id]/models/[modelId]">) => {
    const identity = await requireIdentity();
    const { id, modelId } = await ctx.params;
    const workspaceId = workspaceOf(id);
    assertManages(identity, workspaceId);
    await deleteModel(workspaceOwner(workspaceId), modelId);
    audit({
      actor: identity,
      action: "workspace.model.delete",
      workspaceId,
      resource: { type: "model", id: modelId },
    });
    return json({ deleted: true });
  },
);
