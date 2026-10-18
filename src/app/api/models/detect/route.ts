import { z } from "zod";
import { audit } from "@/lib/audit";
import { HttpError, requireIdentity } from "@/lib/auth/authorize";
import { scanLocalModels } from "@/lib/ai/local-models";
import { assertManages } from "@/lib/ai/model-admin";
import { localModelDetection } from "@/lib/config";
import { json, readJson, route } from "@/lib/http";
import { enforceLlmLimits } from "@/lib/limits/llm";
import { WorkspaceId } from "@/lib/workspace-limits";

export const runtime = "nodejs";
export const maxDuration = 30;

const Body = z
  .object({
    // A workspace the caller manages: the gate, and whose limits admit it.
    workspaceId: WorkspaceId,
  })
  .strict();

/**
 * Re-scan (#607): probe `LOCAL_MODEL_ENDPOINTS` again for a model on this
 * machine. The endpoints are the server's; the request names none. Gated as
 * in-app model management is (`source:manage` in the workspace named),
 * admitted by that workspace's rate limit, and audited as `model.detect`.
 * Answers 200 whatever the endpoints said, with their hosts and how many
 * models each listed, never a reply; a 404 when detection is off.
 */
export const POST = route("models.detect", async (req: Request) => {
  const identity = await requireIdentity();
  const { workspaceId } = await readJson(req, Body, { maxBytes: 1_024 });
  assertManages(identity, workspaceId);
  if (!localModelDetection(process.env)) {
    throw new HttpError(
      404,
      "Detection of a model on this machine is off (LOCAL_MODEL_DETECT).",
    );
  }
  const admitted = await enforceLlmLimits({
    identity,
    workspaceId,
    route: "model-detect",
    model: "detect",
  });
  // A scan spends no tokens; the slot it held (#496) is freed after.
  const scan = await scanLocalModels({ env: process.env }).finally(() =>
    admitted.release(),
  );
  const endpoints = (scan?.endpoints ?? []).map((e) => ({
    host: e.host,
    ok: e.ok,
    models: e.models.length,
  }));
  const found = endpoints.reduce((n, e) => n + e.models, 0);
  audit({
    actor: identity,
    action: "model.detect",
    workspaceId,
    resource: { type: "workspace", id: workspaceId },
    outcome: "success",
    detail: {
      found,
      answered: endpoints.filter((e) => e.ok).map((e) => e.host),
      skipped: endpoints.filter((e) => !e.ok).map((e) => e.host),
    },
  });
  return json({ ok: true, found, endpoints });
});
