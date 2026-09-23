import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "@/lib/auth/authorize";
import { parseGroups } from "@/lib/auth/claims";
import { MemoryBudgetStore, utcDay } from "@/lib/limits/budget";
import { enforceLlmLimits, type WorkspaceLimits } from "@/lib/limits/llm";
import { MemoryRateLimitStore } from "@/lib/limits/rate";
import {
  applyLimitsPatch,
  WorkspaceId,
  WorkspaceLimitsPatch,
  workspaceLimitsView,
} from "@/lib/workspace-limits";

const NOW = new Date("2026-09-23T12:00:00Z");
const DEFAULTS = { ratePerMinute: 20, dailyTokenBudget: 1_000 };

function view(overrides: WorkspaceLimits | null, totalTokens = 0) {
  return workspaceLimitsView({
    workspaceId: "w",
    defaults: DEFAULTS,
    overrides,
    usage: {
      inputTokens: totalTokens,
      outputTokens: 0,
      requests: totalTokens > 0 ? 1 : 0,
    },
    now: NOW,
  });
}

test("a workspace with no row inherits both defaults", () => {
  const v = view(null);
  assert.equal(v.dailyTokenBudget.effective, 1_000);
  assert.equal(v.dailyTokenBudget.source, "global");
  assert.equal(v.dailyTokenBudget.override, null);
  assert.equal(v.ratePerMinute.effective, 20);
  assert.equal(v.ratePerMinute.source, "global");
});

test("a NULL column inherits and a set column overrides, independently", () => {
  const v = view({ ratePerMinute: 5, dailyTokenBudget: null });
  assert.equal(v.ratePerMinute.effective, 5);
  assert.equal(v.ratePerMinute.source, "override");
  assert.equal(v.dailyTokenBudget.effective, 1_000);
  assert.equal(v.dailyTokenBudget.source, "global");
});

test("0 disables a limit, and a disabled budget has no remaining figure", () => {
  const v = view({ ratePerMinute: 0, dailyTokenBudget: 0 }, 5_000);
  assert.equal(v.ratePerMinute.disabled, true);
  assert.equal(v.dailyTokenBudget.disabled, true);
  assert.equal(v.dailyTokenBudget.remaining, null);
});

test("remaining is the budget less today's input and output tokens, never below 0", () => {
  const v = workspaceLimitsView({
    workspaceId: "w",
    defaults: DEFAULTS,
    overrides: null,
    usage: { inputTokens: 300, outputTokens: 200, requests: 4 },
    now: NOW,
  });
  assert.equal(v.usage.totalTokens, 500);
  assert.equal(v.dailyTokenBudget.remaining, 500);
  assert.equal(view(null, 4_000).dailyTokenBudget.remaining, 0);
});

test("the view says a workspace is out of budget exactly when the gate refuses it", async () => {
  const cases: { overrides: WorkspaceLimits | null; used: number }[] = [
    { overrides: null, used: 999 },
    { overrides: null, used: 1_000 },
    { overrides: { ratePerMinute: null, dailyTokenBudget: 50 }, used: 49 },
    { overrides: { ratePerMinute: null, dailyTokenBudget: 50 }, used: 50 },
    { overrides: { ratePerMinute: null, dailyTokenBudget: 0 }, used: 1_000_000 },
  ];
  for (const { overrides, used } of cases) {
    const budgetStore = new MemoryBudgetStore();
    await budgetStore.record({
      workspaceId: "w",
      day: utcDay(NOW),
      route: "generate",
      model: "m",
      inputTokens: used,
      outputTokens: 0,
    });
    let admitted = true;
    try {
      await enforceLlmLimits(
        {
          identity: parseGroups("u", ["/workspaces/w/editor"]),
          workspaceId: "w",
          route: "generate",
        },
        {
          rateStore: new MemoryRateLimitStore(),
          budgetStore,
          getWorkspaceLimits: async () => overrides,
          defaults: DEFAULTS,
          now: () => NOW,
          model: () => "m",
        },
      );
    } catch (err) {
      assert.ok(err instanceof HttpError && err.status === 429);
      admitted = false;
    }
    const v = view(overrides, used);
    const viewSaysOpen =
      v.dailyTokenBudget.disabled || (v.dailyTokenBudget.remaining ?? 0) > 0;
    assert.equal(
      viewSaysOpen,
      admitted,
      `used ${used} with ${JSON.stringify(overrides)}`,
    );
  }
});

test("a patch writes the keys it names, null clears one, absent keeps it", () => {
  const current = { ratePerMinute: 5, dailyTokenBudget: 100 };
  assert.deepEqual(applyLimitsPatch(current, { dailyTokenBudget: 200 }), {
    ratePerMinute: 5,
    dailyTokenBudget: 200,
  });
  assert.deepEqual(applyLimitsPatch(current, { ratePerMinute: null }), {
    ratePerMinute: null,
    dailyTokenBudget: 100,
  });
  assert.deepEqual(applyLimitsPatch(null, { ratePerMinute: 0 }), {
    ratePerMinute: 0,
    dailyTokenBudget: null,
  });
});

test("the patch schema accepts whole non-negative numbers and null only", () => {
  assert.ok(WorkspaceLimitsPatch.safeParse({ ratePerMinute: 0 }).success);
  assert.ok(
    WorkspaceLimitsPatch.safeParse({ ratePerMinute: null, dailyTokenBudget: 10 }).success,
  );
  for (const bad of [
    {},
    { ratePerMinute: -1 },
    { ratePerMinute: 1.5 },
    { ratePerMinute: "10" },
    { dailyTokenBudget: Number.MAX_SAFE_INTEGER + 2 },
    { ratePerMinute: 2_147_483_648 },
    { ratePerMinute: 1, workspaceId: "other" },
  ]) {
    assert.equal(WorkspaceLimitsPatch.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("a workspace id must look like a group path segment", () => {
  for (const ok of ["demo", "team-a", "acme.prod", "w_1"]) {
    assert.ok(WorkspaceId.safeParse(ok).success, ok);
  }
  for (const bad of ["", "../etc", "a/b", " demo", "-lead", "x".repeat(129)]) {
    assert.equal(WorkspaceId.safeParse(bad).success, false, bad);
  }
});
