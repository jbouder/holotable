import { assertAuthorized, requireIdentity } from "@/lib/auth/authorize";
import { workspaceOf } from "@/lib/ai/model-admin";
import { usableModels } from "@/lib/ai/models";
import { HttpError } from "@/lib/auth/authorize";
import { json, route } from "@/lib/http";

export const runtime = "nodejs";

/**
 * The models the caller may use in a workspace (#439): the server's, the
 * workspace's own and, where the workspace allows them, the caller's
 * personal ones, with the id a request without `modelId` resolves to. Ids,
 * names, provider kinds and model ids only: never settings beyond the model
 * id, never credentials.
 */
export const GET = route("models.list", async (req: Request) => {
  const identity = await requireIdentity();
  const raw = new URL(req.url).searchParams.get("workspace");
  if (!raw) throw new HttpError(400, "workspace is required");
  const workspaceId = workspaceOf(raw);
  assertAuthorized(
    identity,
    "source:use",
    { workspaceId },
    { type: "workspace", id: workspaceId },
  );
  return json(await usableModels(identity, workspaceId));
});
