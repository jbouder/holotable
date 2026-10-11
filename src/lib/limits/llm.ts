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
 *
 * It is also the one place every model call passes through, so it is where
 * `/api/metrics` (#51) counts requests and tokens. The gate's own verdict is
 * the counter's `outcome`: what happens to an admitted call afterwards is the
 * provider's business, and the tokens it spent are counted when the recorder
 * fires.
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
import { LlmReservations, RESERVE_TOKENS_PER_CALL } from "@/lib/limits/reservations";
import { log } from "@/lib/log";
import { recordLlmRequest, recordLlmTokens } from "@/lib/metrics";

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
  /** Admitted, unsettled calls (#496): reserved budget and the in-flight count. */
  reservations: LlmReservations;
  /** Most calls in flight across every workspace; 0 is no cap. */
  maxInFlight: number;
  /** How long an unsettled reservation lasts: the model deadline, plus slack. */
  reservationTtlMs: number;
}

export interface LlmUsageRecorder {
  /**
   * Persist a finished call's usage. Never throws and never blocks the
   * response: a failure to record is logged, not surfaced.
   */
  record(usage: LanguageModelUsage): void;
  /**
   * Settle without usage, for a caller that turned out not to call the model.
   * Recording settles too; either is safe to call more than once.
   */
  release(): void;
}

/** One bucket map per server instance, shared by all three routes. */
const rateStore = new MemoryRateLimitStore();
/** One set of reservations per server instance, like the buckets. */
const reservations = new LlmReservations();

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
    reservations,
    maxInFlight: config.llmMaxInFlight,
    reservationTtlMs: config.aiRequestTimeoutMs + 15_000,
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

/** What a refusal for a busy server tells the caller to wait, in seconds. */
const BUSY_RETRY_SECONDS = 5;

/**
 * Admit one model call for `identity` in `workspaceId`, or throw a 429.
 * Call it after `assertAuthorized`, before the model is invoked.
 */
export async function enforceLlmLimits(
  input: {
    identity: Identity;
    workspaceId: string;
    route: LlmRoute;
    /** The resolved model's id (#331); the environment's when not given. */
    model?: string;
  },
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
    recordLlmRequest(route, "rate_limited");
    const seconds = Math.max(1, Math.ceil(rate.retryAfterMs / 1000));
    const resetAt = new Date(now.getTime() + rate.retryAfterMs);
    throw new HttpError(
      429,
      `rate limit reached: ${fmt.format(limits.ratePerMinute)} model requests per minute per user in this workspace; retry after ${seconds}s (at ${resetAt.toISOString()})`,
      { "Retry-After": String(seconds) },
    );
  }

  // 2. The global cap (#496): calls in flight across every workspace, so a
  //    burst reaches this gate, not the provider's own rate limit.
  if (
    deps.maxInFlight > 0 &&
    deps.reservations.inFlight(now.getTime()) >= deps.maxInFlight
  ) {
    recordLlmRequest(route, "busy");
    throw new HttpError(
      429,
      `the model is busy: ${fmt.format(deps.maxInFlight)} requests are already running on this server; retry after ${BUSY_RETRY_SECONDS}s`,
      { "Retry-After": String(BUSY_RETRY_SECONDS) },
    );
  }

  // 3. Budget: tokens already used today across every route in the workspace,
  //    and those reserved by calls admitted and still running (#496).
  const day = utcDay(now);
  const budget = checkBudget(
    (await deps.budgetStore.tokensUsed(workspaceId, day)) +
      deps.reservations.reserved(workspaceId, day, now.getTime()),
    { dailyTokens: limits.dailyTokenBudget },
    now,
  );
  if (!budget.allowed) {
    recordLlmRequest(route, "over_budget");
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

  const model = input.model || deps.model();
  recordLlmRequest(route, "admitted");
  // Admitted: hold an estimate against today until the usage is known. It
  // expires at the model deadline if nothing ever settles it.
  const settle = deps.reservations.reserve({
    workspaceId,
    day,
    tokens: limits.dailyTokenBudget > 0 ? RESERVE_TOKENS_PER_CALL : 0,
    expiresAt: now.getTime() + deps.reservationTtlMs,
  });
  return {
    release: settle,
    record(usage) {
      settle();
      const tokens = tokensFromUsage(usage);
      recordLlmTokens({ workspaceId, model, ...tokens });
      void deps.budgetStore
        .record({ workspaceId, day: utcDay(deps.now()), route, model, ...tokens })
        .catch((err: unknown) => {
          log.error("llm.usage_record_failed", { route, model, err });
        });
    },
  };
}
