import { requireIdentity } from "@/lib/auth/authorize";
import { accountSummary } from "@/lib/account";
import { json, route } from "@/lib/http";

export const runtime = "nodejs";

/**
 * The caller's own identity (#208): subject, display-only profile, and the
 * workspaces and roles the session carries. It takes no parameters, so it can
 * only ever describe the identity that asked. 401 without a session.
 */
export const GET = route("me", async () => {
  const identity = await requireIdentity();
  return json(accountSummary(identity));
});
