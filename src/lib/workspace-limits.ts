import { z } from "zod";
import { checkBudget } from "@/lib/limits/budget";
import { type LlmLimits, resolveLimits, type WorkspaceLimits } from "@/lib/limits/llm";

/**
 * What the workspace settings section shows and edits (#218): today's model
 * usage against the effective rate limit and token budget.
 *
 * The effective values come from {@link resolveLimits} and the remaining
 * budget from {@link checkBudget}, the same two functions `enforceLlmLimits`
 * admits a call with, so the page cannot show a limit the gate does not
 * enforce. A `null` override inherits the environment's value; `0` disables
 * the limit.
 */

/** A workspace id as it appears in a group path segment. */
export const WorkspaceId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, "not a valid workspace id");

/** `rate_per_minute` is an INTEGER column. */
const MAX_RATE = 2_147_483_647;

/**
 * A change to a workspace's overrides. A key that is present is written
 * (`null` clears the override so the workspace inherits again); a key that is
 * absent is left as it is. An empty object is refused rather than treated as
 * a no-op, since it is almost certainly a client bug.
 */
export const WorkspaceLimitsPatch = z
  .strictObject({
    ratePerMinute: z
      .number()
      .int("must be a whole number")
      .min(0, "must be 0 or more")
      .max(MAX_RATE, "is too large")
      .nullable()
      .optional(),
    dailyTokenBudget: z
      .number()
      .int("must be a whole number")
      .min(0, "must be 0 or more")
      .max(Number.MAX_SAFE_INTEGER, "is too large")
      .nullable()
      .optional(),
  })
  .refine(
    (p) => p.ratePerMinute !== undefined || p.dailyTokenBudget !== undefined,
    "set ratePerMinute or dailyTokenBudget",
  );
export type WorkspaceLimitsPatch = z.infer<typeof WorkspaceLimitsPatch>;

/** Today's `llm_usage` totals for one workspace, across routes and models. */
export interface WorkspaceUsage {
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

export const NO_USAGE: WorkspaceUsage = { inputTokens: 0, outputTokens: 0, requests: 0 };

export interface LimitView {
  /** What the gate enforces. */
  effective: number;
  /** The workspace's own value, or `null` when it inherits. */
  override: number | null;
  /** The environment's value, which `null` inherits. */
  global: number;
  source: "global" | "override";
  /** `0` turns the limit off. */
  disabled: boolean;
}

export interface WorkspaceLimitsView {
  workspaceId: string;
  usage: WorkspaceUsage & { totalTokens: number };
  dailyTokenBudget: LimitView & {
    /** Tokens left today, or `null` when the budget is disabled. */
    remaining: number | null;
  };
  ratePerMinute: LimitView;
}

function limitView(
  effective: number,
  override: number | null,
  global: number,
): LimitView {
  return {
    effective,
    override,
    global,
    source: override === null ? "global" : "override",
    disabled: effective <= 0,
  };
}

export function workspaceLimitsView(input: {
  workspaceId: string;
  defaults: LlmLimits;
  overrides: WorkspaceLimits | null;
  usage: WorkspaceUsage | null;
  now: Date;
}): WorkspaceLimitsView {
  const { workspaceId, defaults, overrides, now } = input;
  const usage = input.usage ?? NO_USAGE;
  const limits = resolveLimits(defaults, overrides);
  const totalTokens = usage.inputTokens + usage.outputTokens;
  const budget = checkBudget(totalTokens, { dailyTokens: limits.dailyTokenBudget }, now);
  return {
    workspaceId,
    usage: { ...usage, totalTokens },
    dailyTokenBudget: {
      ...limitView(
        limits.dailyTokenBudget,
        overrides?.dailyTokenBudget ?? null,
        defaults.dailyTokenBudget,
      ),
      remaining: Number.isFinite(budget.remaining) ? budget.remaining : null,
    },
    ratePerMinute: limitView(
      limits.ratePerMinute,
      overrides?.ratePerMinute ?? null,
      defaults.ratePerMinute,
    ),
  };
}

/** The row after `patch` is applied to `current`. */
export function applyLimitsPatch(
  current: WorkspaceLimits | null,
  patch: WorkspaceLimitsPatch,
): WorkspaceLimits {
  return {
    ratePerMinute:
      patch.ratePerMinute === undefined
        ? (current?.ratePerMinute ?? null)
        : patch.ratePerMinute,
    dailyTokenBudget:
      patch.dailyTokenBudget === undefined
        ? (current?.dailyTokenBudget ?? null)
        : patch.dailyTokenBudget,
  };
}
