import { z } from "zod";
import { audit } from "@/lib/audit";
import { assertAuthorized, HttpError, requireIdentity } from "@/lib/auth/authorize";
import { ModelConfigInput } from "@/lib/ai/model-config";
import {
  assertManages,
  modelsToDiscover,
  personalOwner,
  workspaceOwner,
} from "@/lib/ai/model-admin";
import { defaultModelDeps } from "@/lib/ai/model-resolution";
import { endpointHost } from "@/lib/ai/providers/registry";
import { json, readJson, route } from "@/lib/http";
import { enforceLlmLimits } from "@/lib/limits/llm";
import { WorkspaceId } from "@/lib/workspace-limits";

export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z
  .object({
    /** Whose model the form is for: the same roles as the test routes. */
    owner: z.enum(["workspace", "personal"]),
    // A workspace model's workspace, or the workspace whose limits admit a
    // personal model's listing (one that allows personal models).
    workspaceId: WorkspaceId,
    config: ModelConfigInput,
    // A saved model whose stored credentials stand in for blank fields.
    modelId: z.string().max(64).optional(),
  })
  .strict();

/**
 * "List models" (#443): the ids a vendor offers the credentials in the form,
 * saved or not, read through the kind's guarded fetch under a byte cap.
 * The same body and roles as the test routes: `source:manage` for a
 * workspace's model; for a person's own, `dashboard:generate` in a
 * workspace that allows personal models. Admitted by that workspace's rate
 * limit. Answers 200 either way: `{ ok: true, models }`, or `{ ok: false,
 * message }` in words that never carry a credential or the vendor's body.
 */
export const POST = route("models.discover", async (req: Request) => {
  const identity = await requireIdentity();
  const deps = defaultModelDeps();
  const body = await readJson(req, Body, { maxBytes: 16_384 });
  const { workspaceId } = body;
  let owner: Parameters<typeof modelsToDiscover>[0];
  if (body.owner === "workspace") {
    assertManages(identity, workspaceId);
    owner = workspaceOwner(workspaceId);
  } else {
    owner = personalOwner(identity);
    assertAuthorized(
      identity,
      "dashboard:generate",
      { workspaceId },
      { type: "workspace", id: workspaceId },
    );
    const settings = await deps.store.workspace(workspaceId);
    if (!settings?.allowPersonalKeys) {
      throw new HttpError(403, "This workspace does not allow personal models.");
    }
  }
  const admitted = await enforceLlmLimits({
    identity,
    workspaceId,
    route: "model-discover",
    model: body.config.settings.model || "discover",
  });
  // Listing models spends no tokens; the slot it held (#496) is freed after.
  const result = await modelsToDiscover(
    owner,
    body.config,
    body.modelId ?? null,
    deps,
  ).finally(() => admitted.release());
  const detail = {
    provider: body.config.settings.provider,
    endpointHost: endpointHost(body.config.settings),
    ...(result.ok ? { count: result.models.length } : {}),
  };
  if (body.owner === "workspace") {
    audit({
      actor: identity,
      action: "workspace.model.discover",
      workspaceId,
      resource: { type: "workspace", id: workspaceId },
      outcome: result.ok ? "success" : "failure",
      detail,
    });
  } else {
    audit({
      actor: identity,
      action: "user.model.discover",
      workspaceId,
      outcome: result.ok ? "success" : "failure",
      detail,
    });
  }
  return json(result);
});
