import { assertAuthorized, HttpError, requireIdentity } from "@/lib/auth/authorize";
import { config } from "@/lib/config";
import { saveWorkspaceLimits, usageForDay } from "@/lib/db/repo";
import { json, readJson, route } from "@/lib/http";
import { utcDay } from "@/lib/limits/budget";
import { log } from "@/lib/log";
import {
  applyLimitsPatch,
  WorkspaceId,
  WorkspaceLimitsPatch,
  workspaceLimitsView,
} from "@/lib/workspace-limits";

export const runtime = "nodejs";

/**
 * Change a workspace's LLM rate limit and daily token budget overrides (#218).
 *
 * `workspace:limits` is granted by no workspace role, so only a platform
 * admin gets past `assertAuthorized`: a source-admin reads their limits on the
 * settings page but cannot raise them. The workspace id is the path segment,
 * which is the resource being changed rather than a claim about the caller,
 * and it is validated before it reaches the database.
 *
 * The limiter reads `workspace_limits` on every admission, with no cache, so
 * the change applies to the next model call without a restart.
 */
export const PATCH = route(
  "workspaces.limits.update",
  async (req: Request, ctx: RouteContext<"/api/workspaces/[id]/limits">) => {
    const identity = await requireIdentity();
    const { id } = await ctx.params;
    const workspaceId = WorkspaceId.safeParse(id);
    if (!workspaceId.success) throw new HttpError(400, "invalid workspace id");
    assertAuthorized(identity, "workspace:limits", { workspaceId: workspaceId.data });

    const patch = await readJson(req, WorkspaceLimitsPatch, { maxBytes: 1_024 });
    const { before, after } = await saveWorkspaceLimits(workspaceId.data, (current) =>
      applyLimitsPatch(current, patch),
    );
    log.info("workspace_limits.changed", {
      workspaceId: workspaceId.data,
      before,
      after,
    });

    const now = new Date();
    const usage = await usageForDay([workspaceId.data], utcDay(now));
    return json(
      workspaceLimitsView({
        workspaceId: workspaceId.data,
        defaults: {
          ratePerMinute: config.llmRatePerMinute,
          dailyTokenBudget: config.llmDailyTokenBudget,
        },
        overrides: after,
        usage: usage.get(workspaceId.data) ?? null,
        now,
      }),
    );
  },
);
