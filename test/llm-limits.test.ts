import { test } from "node:test";
import assert from "node:assert/strict";
import type { LanguageModelUsage } from "ai";
import { HttpError } from "@/lib/auth/authorize";
import { parseGroups } from "@/lib/auth/claims";
import {
  MemoryBudgetStore,
  checkBudget,
  nextUtcMidnight,
  tokensFromUsage,
  utcDay,
} from "@/lib/limits/budget";
import {
  type LlmLimitDeps,
  type WorkspaceLimits,
  enforceLlmLimits,
  resolveLimits,
} from "@/lib/limits/llm";
import { MemoryRateLimitStore, takeToken } from "@/lib/limits/rate";

/* -------------------------------------------------------------------------- */
/* Token bucket                                                               */
/* -------------------------------------------------------------------------- */

test("a fresh bucket allows a burst of perMinute requests, then refuses", () => {
  let bucket: ReturnType<typeof takeToken>["bucket"] | undefined;
  const policy = { perMinute: 3 };
  for (let i = 0; i < 3; i++) {
    const r = takeToken(bucket, policy, 1_000);
    bucket = r.bucket;
    assert.equal(r.decision.allowed, true, `request ${i + 1} allowed`);
    assert.equal(r.decision.remaining, 2 - i);
  }
  const refused = takeToken(bucket, policy, 1_000);
  assert.equal(refused.decision.allowed, false);
  assert.equal(refused.decision.remaining, 0);
  // 3 per minute is one token every 20s.
  assert.equal(refused.decision.retryAfterMs, 20_000);
});

test("the bucket refills continuously at perMinute per minute and caps at capacity", () => {
  const policy = { perMinute: 60 };
  // Drain it.
  let { bucket } = takeToken(undefined, policy, 0);
  for (let i = 0; i < 59; i++) bucket = takeToken(bucket, policy, 0).bucket;
  assert.equal(takeToken(bucket, policy, 0).decision.allowed, false);
  // 1s later one token has refilled.
  const after1s = takeToken(bucket, policy, 1_000);
  assert.equal(after1s.decision.allowed, true);
  assert.equal(takeToken(after1s.bucket, policy, 1_000).decision.allowed, false);
  // An hour idle refills to capacity, not beyond.
  const idle = takeToken(after1s.bucket, policy, 3_600_000);
  assert.equal(idle.decision.remaining, 59);
});

test("the store keeps callers apart and sweeps buckets that have refilled", async () => {
  const store = new MemoryRateLimitStore(/* sweepEvery */ 4);
  const policy = { perMinute: 1 };
  assert.equal((await store.take("a", policy, 0)).allowed, true);
  assert.equal((await store.take("a", policy, 0)).allowed, false);
  assert.equal((await store.take("b", policy, 0)).allowed, true, "other key unaffected");
  assert.equal(store.size, 2);
  // Fourth take triggers a sweep; both buckets are a minute old and full again.
  assert.equal((await store.take("c", policy, 60_000)).allowed, true);
  assert.equal(store.size, 1);
});

test("perMinute 0 disables the rate limit", async () => {
  const store = new MemoryRateLimitStore();
  for (let i = 0; i < 100; i++) {
    assert.equal((await store.take("a", { perMinute: 0 }, 0)).allowed, true);
  }
  assert.equal(store.size, 0);
});

/* -------------------------------------------------------------------------- */
/* Daily budget                                                               */
/* -------------------------------------------------------------------------- */

test("utc day boundaries", () => {
  const late = new Date("2026-09-20T23:59:59.999Z");
  assert.equal(utcDay(late), "2026-09-20");
  assert.equal(nextUtcMidnight(late).toISOString(), "2026-09-21T00:00:00.000Z");
  assert.equal(utcDay(new Date("2026-12-31T12:00:00Z")), "2026-12-31");
  assert.equal(
    nextUtcMidnight(new Date("2026-12-31T12:00:00Z")).toISOString(),
    "2027-01-01T00:00:00.000Z",
  );
});

test("the budget admits while under and refuses once reached", () => {
  const now = new Date("2026-09-20T10:00:00Z");
  const policy = { dailyTokens: 1_000 };
  assert.equal(checkBudget(0, policy, now).allowed, true);
  assert.equal(checkBudget(999, policy, now).remaining, 1);
  assert.equal(checkBudget(999, policy, now).allowed, true);
  const full = checkBudget(1_000, policy, now);
  assert.equal(full.allowed, false);
  assert.equal(full.remaining, 0);
  assert.equal(full.resetAt.toISOString(), "2026-09-21T00:00:00.000Z");
  assert.equal(checkBudget(5_000, { dailyTokens: 0 }, now).allowed, true, "0 disables");
});

test("usage without token counts records zeros, never NaN", () => {
  const usage = {
    inputTokens: undefined,
    outputTokens: Number.NaN,
  } as unknown as LanguageModelUsage;
  assert.deepEqual(tokensFromUsage(usage), { inputTokens: 0, outputTokens: 0 });
  assert.deepEqual(
    tokensFromUsage({ inputTokens: 12.4, outputTokens: 7 } as LanguageModelUsage),
    { inputTokens: 12, outputTokens: 7 },
  );
});

test("the memory store sums a workspace's day across routes and models only", async () => {
  const store = new MemoryBudgetStore();
  const base = { workspaceId: "ws", day: "2026-09-20", model: "m" };
  await store.record({ ...base, route: "generate", inputTokens: 100, outputTokens: 50 });
  await store.record({ ...base, route: "chat", inputTokens: 10, outputTokens: 5 });
  await store.record({
    ...base,
    route: "chat",
    model: "m2",
    inputTokens: 1,
    outputTokens: 1,
  });
  await store.record({
    ...base,
    day: "2026-09-21",
    route: "chat",
    inputTokens: 999,
    outputTokens: 0,
  });
  await store.record({
    ...base,
    workspaceId: "other",
    route: "chat",
    inputTokens: 999,
    outputTokens: 0,
  });
  assert.equal(await store.tokensUsed("ws", "2026-09-20"), 167);
  assert.equal(await store.tokensUsed("ws", "2026-09-21"), 999);
  assert.equal(await store.tokensUsed("nobody", "2026-09-20"), 0);
});

/* -------------------------------------------------------------------------- */
/* Overrides                                                                  */
/* -------------------------------------------------------------------------- */

test("a workspace row overrides only the columns it sets; 0 disables", () => {
  const defaults = { ratePerMinute: 20, dailyTokenBudget: 2_000_000 };
  assert.deepEqual(resolveLimits(defaults, null), defaults);
  assert.deepEqual(
    resolveLimits(defaults, { ratePerMinute: null, dailyTokenBudget: null }),
    defaults,
  );
  assert.deepEqual(
    resolveLimits(defaults, { ratePerMinute: 5, dailyTokenBudget: null }),
    {
      ratePerMinute: 5,
      dailyTokenBudget: 2_000_000,
    },
  );
  assert.deepEqual(resolveLimits(defaults, { ratePerMinute: 0, dailyTokenBudget: 0 }), {
    ratePerMinute: 0,
    dailyTokenBudget: 0,
  });
});

/* -------------------------------------------------------------------------- */
/* enforceLlmLimits                                                           */
/* -------------------------------------------------------------------------- */

function harness(opts: {
  ratePerMinute?: number;
  dailyTokenBudget?: number;
  overrides?: Record<string, WorkspaceLimits>;
  start?: string;
}) {
  const clock = { now: new Date(opts.start ?? "2026-09-20T10:00:00Z") };
  const budgetStore = new MemoryBudgetStore();
  const deps: LlmLimitDeps = {
    rateStore: new MemoryRateLimitStore(),
    budgetStore,
    getWorkspaceLimits: async (id) => opts.overrides?.[id] ?? null,
    defaults: {
      ratePerMinute: opts.ratePerMinute ?? 20,
      dailyTokenBudget: opts.dailyTokenBudget ?? 2_000_000,
    },
    now: () => clock.now,
    model: () => "test-model",
  };
  return { deps, clock, budgetStore };
}

const alice = parseGroups("alice", ["/workspaces/ws/editor"]);
const bob = parseGroups("bob", ["/workspaces/ws/editor"]);
const usage = (n: number) =>
  ({ inputTokens: n, outputTokens: 0 }) as unknown as LanguageModelUsage;

async function expect429(
  fn: () => Promise<unknown>,
  message: RegExp,
): Promise<HttpError> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof HttpError, `expected HttpError, got ${String(err)}`);
    assert.equal(err.status, 429);
    assert.match(err.message, message);
    assert.match(err.headers["Retry-After"] ?? "", /^\d+$/);
    return err;
  }
  assert.fail("expected a 429");
}

test("the rate limit is per (workspace, user) and names when to retry", async () => {
  const { deps, clock } = harness({ ratePerMinute: 2 });
  const admit = (identity: typeof alice, workspaceId = "ws") =>
    enforceLlmLimits({ identity, workspaceId, route: "generate" }, deps);

  await admit(alice);
  await admit(alice);
  const err = await expect429(
    () => admit(alice),
    /rate limit reached: 2 model requests per minute per user in this workspace; retry after 30s \(at 2026-09-20T10:00:30\.000Z\)/,
  );
  assert.equal(err.headers["Retry-After"], "30");

  // Bob and another workspace have their own buckets.
  await admit(bob);
  await admit(alice, "ws-2");

  // Half a minute later Alice gets one token back.
  clock.now = new Date("2026-09-20T10:00:30Z");
  await admit(alice);
  await expect429(() => admit(alice), /rate limit reached/);
});

test("the budget counts recorded usage and refuses at the ceiling until midnight UTC", async () => {
  const { deps, budgetStore } = harness({ dailyTokenBudget: 1_000 });
  const admit = () =>
    enforceLlmLimits({ identity: alice, workspaceId: "ws", route: "chat" }, deps);

  const first = await admit();
  first.record(usage(600));
  await new Promise((r) => setImmediate(r));
  assert.equal(await budgetStore.tokensUsed("ws", "2026-09-20"), 600);

  // 600 < 1000: still admitted, and this call takes it over.
  const second = await admit();
  second.record(usage(600));
  await new Promise((r) => setImmediate(r));

  const err = await expect429(
    admit,
    /daily token budget reached: 1,200 of 1,000 tokens used in this workspace today; resets at 2026-09-21T00:00:00\.000Z/,
  );
  // 14h to midnight.
  assert.equal(err.headers["Retry-After"], String(14 * 3600));

  // Another workspace is unaffected.
  await enforceLlmLimits({ identity: alice, workspaceId: "ws-2", route: "chat" }, deps);
});

test("recorded usage carries the route and model for the metrics counters", async () => {
  const { deps, budgetStore } = harness({});
  const rec = await enforceLlmLimits(
    { identity: alice, workspaceId: "ws", route: "source-draft" },
    deps,
  );
  rec.record({ inputTokens: 40, outputTokens: 2 } as LanguageModelUsage);
  await new Promise((r) => setImmediate(r));
  const rows = [...budgetStore.rows.values()];
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    workspaceId: "ws",
    day: "2026-09-20",
    route: "source-draft",
    model: "test-model",
    inputTokens: 40,
    outputTokens: 2,
    requests: 1,
  });
});

test("a failing usage store is logged, not surfaced", async () => {
  const { deps } = harness({});
  deps.budgetStore = {
    tokensUsed: async () => 0,
    record: async () => {
      throw new Error("db down");
    },
  };
  const logged: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    const rec = await enforceLlmLimits(
      { identity: alice, workspaceId: "ws", route: "generate" },
      deps,
    );
    assert.doesNotThrow(() => rec.record(usage(1)));
    await new Promise((r) => setImmediate(r));
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 1);
});

test("per-workspace overrides win over the environment, and 0 lifts a limit", async () => {
  const { deps } = harness({
    ratePerMinute: 1,
    dailyTokenBudget: 1,
    overrides: {
      generous: { ratePerMinute: 0, dailyTokenBudget: 0 },
      strict: { ratePerMinute: null, dailyTokenBudget: 1 },
    },
  });
  for (let i = 0; i < 5; i++) {
    await enforceLlmLimits(
      { identity: alice, workspaceId: "generous", route: "chat" },
      deps,
    );
  }
  await enforceLlmLimits({ identity: alice, workspaceId: "strict", route: "chat" }, deps);
  await expect429(
    () =>
      enforceLlmLimits({ identity: alice, workspaceId: "strict", route: "chat" }, deps),
    /rate limit reached: 1 model requests/,
  );
});

test("platform admins are rate limited like everyone else", async () => {
  const { deps } = harness({ ratePerMinute: 1 });
  const admin = parseGroups("root", ["/platform-admins"]);
  assert.equal(admin.platformAdmin, true);
  await enforceLlmLimits({ identity: admin, workspaceId: "ws", route: "generate" }, deps);
  await expect429(
    () =>
      enforceLlmLimits({ identity: admin, workspaceId: "ws", route: "generate" }, deps),
    /rate limit reached/,
  );
});
