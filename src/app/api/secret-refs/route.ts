import { assertAuthorized, HttpError, requireIdentity } from "@/lib/auth/authorize";
import { json, route } from "@/lib/http";
import { MemoryRateLimitStore } from "@/lib/limits/rate";
import { grantedSecretRefStatus } from "@/lib/secrets/credentials";

export const runtime = "nodejs";

/**
 * The ceiling on list requests, per user per workspace.
 *
 * A constant rather than a setting: this is not a capacity knob an operator
 * would tune but a ceiling on how fast the endpoint can be asked anything at
 * all. The form and the source list each ask once per mount.
 */
const RATE_PER_MINUTE = 60;

const rateStore = new MemoryRateLimitStore();

/**
 * List the `secret_ref`s granted to a workspace, each with whether the server
 * holds credentials for it.
 *
 * Three things keep this from being a way to read the environment:
 *
 * - it is gated on `source:manage` in a named workspace, the same role that
 *   may create a source that would use the refs;
 * - it answers only about refs `SOURCE_SECRET_REFS` grants to that workspace,
 *   so the caller cannot ask about a name of their choosing, nor learn which
 *   refs other workspaces hold; and
 * - it is rate limited per caller.
 *
 * The answer is `{ refs: [{ ref, configured }] }` — names the operator
 * declared for this workspace, and a boolean each. Never a username, never a
 * length, never anything computed from a password.
 */
export const GET = route("secret-refs.list", async (req: Request) => {
  const identity = await requireIdentity();
  const workspaceId = new URL(req.url).searchParams.get("workspaceId");
  if (!workspaceId) throw new HttpError(400, "workspaceId is required");

  assertAuthorized(identity, "source:manage", { workspaceId });

  const decision = await rateStore.take(
    `${workspaceId}\u0000${identity.sub}`,
    { perMinute: RATE_PER_MINUTE },
    Date.now(),
  );
  if (!decision.allowed) {
    const seconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
    throw new HttpError(
      429,
      `too many credential reference checks: ${RATE_PER_MINUTE} per minute per user in this workspace; retry after ${seconds}s`,
      { "Retry-After": String(seconds) },
    );
  }

  return json(
    { refs: grantedSecretRefStatus(workspaceId) },
    { headers: { "cache-control": "no-store" } },
  );
});
