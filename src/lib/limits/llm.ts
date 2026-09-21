/**
 * Admission control for the LLM-backed routes.
 *
 * `enforceLlmLimits` runs immediately after `assertAuthorized` in every route
 * that calls the model, and nowhere else: the limiter is a server-side gate
 * keyed by the validated identity and a workspace resolved from a trusted
 * record, never from the request body. It applies, in order:
 *
 *   1. a token-bucket rate limit per `(workspace, user)`, and
 *   2. a daily token budget per workspace,
 *
 * and throws `HttpError(429)` naming the limit that was hit and when it
 * resets. Both ceilings come from the environment (`LLM_RATE_PER_MINUTE`,
 * `LLM_DAILY_TOKEN_BUDGET`) and may be overridden per workspace by a
 * `workspace_limits` row.
 *
 * On success it returns a recorder; the route hands the recorder to the
 * stream's finish callback so the call's usage lands in `llm_usage`.
 */

import type { LanguageModelUsage } from "ai";
import { HttpError } from "@/lib/auth/authorize";
import type { Identity } from "@/lib/auth/claims";
import { config } from "@/lib/config";
import { getWorkspaceLimits, pgBudgetStore } from "@/lib/db/repo";
import {
  type BudgetStore,
  checkBudget,
  type LlmRoute,
  tokensFromUsage,
  utcDay,
} from "@/lib/limits/budget";
import { MemoryRateLimitStore, type RateLimitStore } from "@/lib/limits/rate";

export type { LlmRoute } from "@/lib/limits/budget";

/** Effective ceilings for one workspace after overrides are applied. */
export interface LlmLimits {
  ratePerMinute: number;
  dailyTokenBudget: number;
}

/** A `workspace_limits` row; `null` inherits the global value. */
export interface WorkspaceLimits {
  ratePerMinute: number | null;
  dailyTokenBudget: number | null;
}

export interface LlmLimitDeps {
  rateStore: RateLimitStore;
  budgetStore: BudgetStore;
  /** Per-workspace overrides, or `null` when the workspace has no row. */
  getWorkspaceLimits: (workspaceId: string) => Promise<WorkspaceLimits | null>;
  /** Global ceilings; defaults to the environment. */
  defaults: LlmLimits;
  now: () => Date;
  /** The model id recorded with usage, for the per-model counters. */
  model: () => string;
}

export interface LlmUsageRecorder {
  /**
   * Persist a finished call's usage. Never throws and never blocks the
   * response: a failure to record is logged, not surfaced.
   */
  record(usage: LanguageModelUsage): void;
}

/** One bucket map per server instance, shared by all three routes. */
const rateStore = new MemoryRateLimitStore();

function defaultDeps(): LlmLimitDeps {
  return {
    rateStore,
    budgetStore: pgBudgetStore,
    getWorkspaceLimits,
    defaults: {
      ratePerMinute: config.llmRatePerMinute,
      dailyTokenBudget: config.llmDailyTokenBudget,
    },
    now: () => new Date(),
    model: () => config.aiModel || "unknown",
  };
}

/** Merge a workspace's overrides onto the global ceilings. */
export function resolveLimits(
  defaults: LlmLimits,
  overrides: WorkspaceLimits | null,
): LlmLimits {
  return {
    ratePerMinute: overrides?.ratePerMinute ?? defaults.ratePerMinute,
    dailyTokenBudget: overrides?.dailyTokenBudget ?? defaults.dailyTokenBudget,
  };
}

const fmt = new Intl.NumberFormat("en-US");

/**
 * Admit one model call for `identity` in `workspaceId`, or throw a 429.
 * Call it after `assertAuthorized`, before the model is invoked.
 */
export async function enforceLlmLimits(
  input: { identity: Identity; workspaceId: string; route: LlmRoute },
  deps: LlmLimitDeps = defaultDeps(),
): Promise<LlmUsageRecorder> {
  const { identity, workspaceId, route } = input;
  const now = deps.now();
  const limits = resolveLimits(deps.defaults, await deps.getWorkspaceLimits(workspaceId));

  // 1. Rate: one bucket per (workspace, user). Platform admins are not exempt;
  //    the limit protects provider spend, not data.
  const rate = await deps.rateStore.take(
    `${workspaceId}\u0000${identity.sub}`,
    { perMinute: limits.ratePerMinute },
    now.getTime(),
  );
  if (!rate.allowed) {
    const seconds = Math.max(1, Math.ceil(rate.retryAfterMs / 1000));
    const resetAt = new Date(now.getTime() + rate.retryAfterMs);
    throw new HttpError(
      429,
      `rate limit reached: ${fmt.format(limits.ratePerMinute)} model requests per minute per user in this workspace; retry after ${seconds}s (at ${resetAt.toISOString()})`,
      { "Retry-After": String(seconds) },
    );
  }

  // 2. Budget: tokens already used today across every route in the workspace.
  const day = utcDay(now);
  const budget = checkBudget(
    await deps.budgetStore.tokensUsed(workspaceId, day),
    { dailyTokens: limits.dailyTokenBudget },
    now,
  );
  if (!budget.allowed) {
    const seconds = Math.max(
      1,
      Math.ceil((budget.resetAt.getTime() - now.getTime()) / 1000),
    );
    throw new HttpError(
      429,
      `daily token budget reached: ${fmt.format(budget.used)} of ${fmt.format(limits.dailyTokenBudget)} tokens used in this workspace today; resets at ${budget.resetAt.toISOString()}`,
      { "Retry-After": String(seconds) },
    );
  }

  const model = deps.model();
  return {
    record(usage) {
      const tokens = tokensFromUsage(usage);
      void deps.budgetStore
        .record({ workspaceId, day: utcDay(deps.now()), route, model, ...tokens })
        .catch((err: unknown) => {
          console.error("failed to record LLM usage:", err);
        });
    },
  };
}
