import { audit } from "@/lib/audit";
import { requireIdentity } from "@/lib/auth/authorize";
import { ModelInput } from "@/lib/ai/model-config";
import {
  deleteModel,
  modelAuditDetail,
  personalOwner,
  updateModel,
} from "@/lib/ai/model-admin";
import { json, readJson, route } from "@/lib/http";

export const runtime = "nodejs";

/** Replace one of the caller's own models (#439). Credentials left out are kept, same origin only. */
export const PUT = route(
  "me.models.update",
  async (req: Request, ctx: RouteContext<"/api/me/models/[modelId]">) => {
    const identity = await requireIdentity();
    const owner = personalOwner(identity);
    const { modelId } = await ctx.params;
    const body = await readJson(req, ModelInput, { maxBytes: 16_384 });
    const updated = await updateModel(owner, modelId, body, identity.sub);
    audit({
      actor: identity,
      action: "user.model.update",
      workspaceId: null,
      resource: { type: "model", id: updated.id },
      detail: modelAuditDetail(body),
    });
    return json(updated);
  },
);

/** Delete one of the caller's own models. */
export const DELETE = route(
  "me.models.delete",
  async (_req: Request, ctx: RouteContext<"/api/me/models/[modelId]">) => {
    const identity = await requireIdentity();
    const owner = personalOwner(identity);
    const { modelId } = await ctx.params;
    await deleteModel(owner, modelId);
    audit({
      actor: identity,
      action: "user.model.delete",
      workspaceId: null,
      resource: { type: "model", id: modelId },
    });
    return json({ deleted: true });
  },
);
