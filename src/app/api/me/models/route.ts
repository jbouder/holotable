import { audit } from "@/lib/audit";
import { requireIdentity } from "@/lib/auth/authorize";
import { ModelInput } from "@/lib/ai/model-config";
import {
  createModel,
  listModels,
  modelAuditDetail,
  personalOwner,
} from "@/lib/ai/model-admin";
import { json, readJson, route } from "@/lib/http";

export const runtime = "nodejs";

/**
 * A person's own models (#439). Every method acts on the session's own
 * models, never a subject from the request, so nobody (a platform admin
 * included) reads or changes another person's. They apply only in a
 * workspace that allows personal models; elsewhere they are kept and
 * ignored. Refused for a service-account token.
 */
export const GET = route("me.models.list", async () => {
  const identity = await requireIdentity();
  return json({ models: await listModels(personalOwner(identity)) });
});

/** Add a personal model. Refused in demo mode. */
export const POST = route("me.models.create", async (req: Request) => {
  const identity = await requireIdentity();
  const owner = personalOwner(identity);
  const body = await readJson(req, ModelInput, { maxBytes: 16_384 });
  const created = await createModel(owner, body, identity.sub);
  audit({
    actor: identity,
    action: "user.model.create",
    workspaceId: null,
    resource: { type: "model", id: created.id },
    detail: modelAuditDetail(body),
  });
  return json(created, { status: 201 });
});
