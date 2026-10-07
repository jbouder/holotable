import { audit } from "@/lib/audit";
import { HttpError, requireIdentity } from "@/lib/auth/authorize";
import type { Identity } from "@/lib/auth/claims";
import { ModelConfigInput, type ModelConfigView } from "@/lib/ai/model-config";
import {
  assertConfigurable,
  configView,
  defaultModelDeps,
  prepareWrite,
} from "@/lib/ai/model-resolution";
import { json, readJson, route } from "@/lib/http";

export const runtime = "nodejs";

/**
 * A person's own model (#331). Every method acts on the session's own row,
 * never a subject from the request, so nobody (a platform admin included)
 * reads or changes another person's. It applies only in a workspace that
 * allows personal keys; elsewhere it is kept and ignored.
 */

/** A service-account token is not a person and has no personal model. */
function person(identity: Identity): Identity {
  if (identity.serviceAccount) {
    throw new HttpError(403, "A service-account token has no personal model.");
  }
  return identity;
}

export const GET = route("me.model.get", async () => {
  const identity = person(await requireIdentity());
  const stored = await defaultModelDeps().store.user(identity.sub);
  const config: ModelConfigView | null = stored ? configView(stored) : null;
  return json({ config });
});

export const PUT = route("me.model.update", async (req: Request) => {
  const identity = person(await requireIdentity());
  const deps = defaultModelDeps();
  assertConfigurable(deps);
  const body = await readJson(req, ModelConfigInput, { maxBytes: 16_384 });
  const current = await deps.store.user(identity.sub);
  const write = await prepareWrite(body, current, deps);
  const saved = await deps.store.saveUser({ sub: identity.sub, config: write });
  audit({
    actor: identity,
    action: "user.model.update",
    workspaceId: null,
    detail: {
      provider: body.settings.provider,
      baseUrlHost: new URL(body.settings.baseUrl).host,
      model: body.settings.model,
      keyChanged: body.apiKey !== undefined,
    },
  });
  return json({ config: configView(saved) });
});

export const DELETE = route("me.model.delete", async () => {
  const identity = person(await requireIdentity());
  const deleted = await defaultModelDeps().store.deleteUser(identity.sub);
  if (deleted) {
    audit({ actor: identity, action: "user.model.delete", workspaceId: null });
  }
  return json({ deleted });
});
