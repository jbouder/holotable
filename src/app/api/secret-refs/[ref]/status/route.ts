import { assertAuthorized, HttpError, requireIdentity } from "@/lib/auth/authorize";
import { json, route } from "@/lib/http";
import { MemoryRateLimitStore } from "@/lib/limits/rate";
import { hasCredentials } from "@/lib/registry";
import { SECRET_REF_MESSAGE, SECRET_REF_PATTERN } from "@/lib/secret-refs";

export const runtime = "nodejs";

/**
 * The ceiling on readiness checks, per user per workspace.
 *
 * A constant rather than a setting: this is not a capacity knob an operator
 * would tune but a ceiling on how fast the endpoint can be asked anything at
 * all. The form debounces to roughly one check per typed ref, so a minute's
 * allowance is generous for a person and useless for a script.
 */
const RATE_PER_MINUTE = 60;

const rateStore = new MemoryRateLimitStore();

/**
 * Report whether the server holds credentials for a `secret_ref`.
 *
 * Three things keep this from being a way to read the environment:
 *
 * - it is gated on `source:manage` in a named workspace, the same role that
 *   may create the source that would use the ref;
 * - the ref must match {@link SECRET_REF_PATTERN}, and only its `_USERNAME`
 *   and `_PASSWORD` members are ever looked at, so no arbitrary variable is
 *   reachable; and
 * - it is rate limited per caller, because a boolean per request is still an
 *   oracle if it can be asked thousands of times a second.
 *
 * The answer is `{ ref, configured }` — the ref the caller just sent back, and
 * a boolean. Never the username, never a length, never anything computed from
 * the password.
 */
export const GET = route(
  "secret-refs.status",
  async (req: Request, ctx: RouteContext<"/api/secret-refs/[ref]/status">) => {
    const identity = await requireIdentity();
    const workspaceId = new URL(req.url).searchParams.get("workspaceId");
    if (!workspaceId) throw new HttpError(400, "workspaceId is required");

    assertAuthorized(identity, "source:manage", { workspaceId });

    // Charged before the ref is validated, so a flood of malformed refs costs
    // the caller exactly what a flood of valid ones does.
    const decision = await rateStore.take(
      `${workspaceId}\u0000${identity.sub}`,
      { perMinute: RATE_PER_MINUTE },
      Date.now(),
    );
    if (!decision.allowed) {
      const seconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
      throw new HttpError(
        429,
        `too many readiness checks: ${RATE_PER_MINUTE} per minute per user in this workspace; retry after ${seconds}s`,
        { "Retry-After": String(seconds) },
      );
    }

    const { ref } = await ctx.params;
    if (!SECRET_REF_PATTERN.test(ref)) throw new HttpError(400, SECRET_REF_MESSAGE);

    return json(
      { ref, configured: hasCredentials(ref) },
      { headers: { "cache-control": "no-store" } },
    );
  },
);
