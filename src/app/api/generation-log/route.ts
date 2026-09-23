import { authorizedWorkspaces, requireIdentity } from "@/lib/auth/authorize";
import { json, route } from "@/lib/http";
import { config } from "@/lib/config";
import { GENERATION_LOG_PAGE, generationLogLimit } from "@/lib/ai/log";
import { listGenerationLog } from "@/lib/db/repo";

export const runtime = "nodejs";

/**
 * Read the generation log (#23): what was asked of the model, what came back,
 * and what it cost.
 *
 * Gated on `source:manage` — a workspace source-admin, or a platform admin by
 * the usual bypass. A viewer or an editor gets an empty list, not a 403: the
 * candidate workspaces come from `authorizedWorkspaces`, which filters the
 * caller's own claims, so `?workspaceId=` narrows the answer and can never
 * widen it. An id the caller cannot read simply matches nothing.
 *
 * This is the ONLY read path. Nothing here rides along on a dashboard, a
 * source or a spec payload: the rows are an operator's record, and a prompt —
 * even redacted — is not something to hand to every reader of a dashboard.
 */
export const GET = route("generation-log", async (req: Request) => {
  const identity = await requireIdentity();
  const params = new URL(req.url).searchParams;
  const workspaces = authorizedWorkspaces(
    identity,
    "source:manage",
    params.get("workspaceId"),
  );

  const entries = await listGenerationLog(workspaces, {
    limit: generationLogLimit(params.get("limit")),
    retentionDays: config.generationLogRetentionDays,
  });

  return json({ entries, limit: GENERATION_LOG_PAGE });
});
