/**
 * Per-workspace daily token budget.
 *
 * The budget is a ceiling on `input + output` tokens across every LLM route
 * in a workspace for one UTC day. Usage is recorded from the AI SDK's `usage`
 * after each call finishes and read back before the next one starts, so a
 * request that would start over budget is refused with a 429 that says when
 * the day rolls over. A request already in flight when the budget runs out is
 * not cut off: the check is a gate at admission, not a meter on the stream.
 *
 * Counters live in a {@link BudgetStore}; the Postgres-backed one persists to
 * `llm_usage` and is the same data the `/metrics` counters read.
 */

import type { LanguageModelUsage } from "ai";

/** Which LLM-backed route produced the usage. A fixed set, safe as a label. */
export type LlmRoute = "generate" | "source-draft" | "chat";

export interface UsageDelta {
  workspaceId: string;
  /** UTC calendar day, `YYYY-MM-DD`. */
  day: string;
  route: LlmRoute;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface BudgetStore {
  /** Total `input + output` tokens recorded for the workspace on `day`. */
  tokensUsed(workspaceId: string, day: string): Promise<number>;
  /** Add one finished call's usage to the day's counters. */
  record(delta: UsageDelta): Promise<void>;
}

export interface BudgetPolicy {
  /** Tokens per UTC day per workspace. `0` disables the limit. */
  dailyTokens: number;
}

export interface BudgetDecision {
  allowed: boolean;
  used: number;
  remaining: number;
  /** Start of the next UTC day, when the counter resets. */
  resetAt: Date;
}

/** `YYYY-MM-DD` of `now` in UTC. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Midnight UTC after `now`. */
export function nextUtcMidnight(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
}

/** Pure decision: may a call start given what the day has already used? */
export function checkBudget(
  used: number,
  policy: BudgetPolicy,
  now: Date,
): BudgetDecision {
  const resetAt = nextUtcMidnight(now);
  if (policy.dailyTokens <= 0) {
    return { allowed: true, used, remaining: Number.POSITIVE_INFINITY, resetAt };
  }
  const remaining = Math.max(0, policy.dailyTokens - used);
  return { allowed: used < policy.dailyTokens, used, remaining, resetAt };
}

/**
 * Reduce the SDK's usage report to the two counters that are billed. A
 * provider that does not report usage yields zeros rather than `NaN`, which
 * would silently disable the budget.
 */
export function tokensFromUsage(usage: LanguageModelUsage): {
  inputTokens: number;
  outputTokens: number;
} {
  const count = (n: number | undefined) =>
    typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  return {
    inputTokens: count(usage.inputTokens),
    outputTokens: count(usage.outputTokens),
  };
}

/** In-memory store for tests and for running without a config store. */
export class MemoryBudgetStore implements BudgetStore {
  readonly rows = new Map<string, UsageDelta & { requests: number }>();

  async tokensUsed(workspaceId: string, day: string): Promise<number> {
    let total = 0;
    for (const row of this.rows.values()) {
      if (row.workspaceId === workspaceId && row.day === day) {
        total += row.inputTokens + row.outputTokens;
      }
    }
    return total;
  }

  async record(delta: UsageDelta): Promise<void> {
    const key = [delta.workspaceId, delta.day, delta.route, delta.model].join("\u0000");
    const row = this.rows.get(key);
    if (row) {
      row.inputTokens += delta.inputTokens;
      row.outputTokens += delta.outputTokens;
      row.requests += 1;
    } else {
      this.rows.set(key, { ...delta, requests: 1 });
    }
  }
}
