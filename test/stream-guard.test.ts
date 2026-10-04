import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { parseGroups, type Identity } from "@/lib/auth/claims";
import { can } from "@/lib/auth/authorize";
import { resetRevocations, revoke, type TokenRef } from "@/lib/auth/revocation";
import {
  guardStream,
  type StreamEnd,
  type StreamGuardOptions,
} from "@/lib/auth/stream-guard";
import {
  ACCESS_ENDED_EVENT,
  accessEndedFrame,
  SESSION_EXPIRED_EVENT,
  sessionExpiredFrame,
} from "@/lib/sse";

/**
 * A dashboard stream stays authorized only as long as its session (#32): it
 * ends at the token's expiry, on a revocation of its session, and when a
 * periodic re-check finds the dashboard no longer viewable — and only that
 * stream ends.
 */

const T0 = 1_800_000_000_000;
const INTERVAL = 60_000;
const alice: Identity = parseGroups("alice", ["/workspaces/ops/viewer"]);

beforeEach(() => {
  resetRevocations();
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: T0 });
});
afterEach(() => mock.timers.reset());

/** Let a re-check's promises settle. */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

async function advance(ms: number) {
  mock.timers.tick(ms);
  await settle();
}

interface Harness {
  ended: StreamEnd[];
  /** The workspace the dashboard is in now; null when it was deleted. */
  dashboard: { workspaceId: string } | null;
  /** What verifying the token again returns now. */
  identity: Identity | null;
  checks: number;
  stop: () => void;
}

function guard(
  overrides: Partial<StreamGuardOptions> & { ref?: TokenRef | null } = {},
): Harness {
  const h: Harness = {
    ended: [],
    dashboard: { workspaceId: "ops" },
    identity: alice,
    checks: 0,
    stop: () => {},
  };
  h.stop = guardStream({
    expiresAt: T0 + 15 * 60_000,
    ref: { sub: "alice", sid: "kc-1", iat: Math.floor(T0 / 1000) },
    intervalMs: INTERVAL,
    verify: async () => {
      h.checks++;
      return h.identity;
    },
    authorize: async (who) =>
      h.dashboard !== null &&
      can(who, "dashboard:view", { workspaceId: h.dashboard.workspaceId }),
    onEnd: (why) => h.ended.push(why),
    ...overrides,
  });
  return h;
}

test("a stream ends when the token it was opened with expires, not before", async () => {
  const h = guard({ expiresAt: T0 + 90_000 });
  await advance(89_999);
  assert.deepEqual(h.ended, []);
  await advance(1);
  assert.deepEqual(h.ended, ["expired"]);
});

test("an expiry beyond what one timer can hold still ends the stream", async () => {
  // `setTimeout` clamps a delay over 2^31-1 ms to fire at once.
  const far = 30 * 24 * 60 * 60_000;
  const h = guard({ expiresAt: T0 + far, intervalMs: 2 ** 30 });
  await advance(2 ** 31 - 1);
  assert.deepEqual(h.ended, [], "the first timer fires early and is rescheduled");
  await advance(far - (2 ** 31 - 1));
  assert.deepEqual(h.ended, ["expired"]);
});

test("revoking the stream's session ends it at once; another session's does not", async () => {
  const h = guard();
  revoke({ sub: "alice", sid: "kc-2" });
  revoke({ sub: "bob" });
  assert.deepEqual(h.ended, []);
  revoke({ sub: "alice", sid: "kc-1" });
  assert.deepEqual(h.ended, ["revoked"]);
});

test("a dashboard moved out of the viewer's workspaces ends the stream at the next check", async () => {
  const h = guard();
  await advance(INTERVAL);
  assert.equal(h.checks, 1);
  assert.deepEqual(h.ended, []);
  h.dashboard = { workspaceId: "finance" };
  await advance(INTERVAL - 1);
  assert.deepEqual(h.ended, [], "not before the interval");
  await advance(1);
  assert.deepEqual(h.ended, ["forbidden"]);
});

test("a deleted dashboard ends the stream as forbidden, the same answer as no access", async () => {
  const h = guard();
  h.dashboard = null;
  await advance(INTERVAL);
  assert.deepEqual(h.ended, ["forbidden"]);
});

test("a token that stops verifying before its expiry ends the stream as revoked", async () => {
  const h = guard();
  h.identity = null;
  await advance(INTERVAL);
  assert.deepEqual(h.ended, ["revoked"]);
});

test("the re-check uses the identity verified now, not the one the stream opened with", async () => {
  const viewerElsewhere = parseGroups("alice", ["/workspaces/finance/viewer"]);
  const h = guard();
  h.identity = viewerElsewhere;
  await advance(INTERVAL);
  assert.deepEqual(h.ended, ["forbidden"]);
});

test("a failed lookup keeps the stream and is tried again", async () => {
  let fail = true;
  const h = guard({
    authorize: async () => {
      if (fail) throw new Error("database unavailable");
      return false;
    },
  });
  await advance(INTERVAL);
  assert.deepEqual(h.ended, []);
  fail = false;
  await advance(INTERVAL);
  assert.deepEqual(h.ended, ["forbidden"]);
});

test("a guard ends once, and stopping it silences everything", async () => {
  const h = guard({ expiresAt: T0 + INTERVAL });
  h.dashboard = null;
  // Expiry and the re-check land on the same instant; one end only.
  await advance(INTERVAL);
  revoke({ sub: "alice", sid: "kc-1" });
  await advance(INTERVAL * 3);
  assert.equal(h.ended.length, 1);

  const quiet = guard();
  quiet.stop();
  quiet.dashboard = null;
  revoke({ sub: "alice" });
  await advance(16 * 60_000);
  assert.deepEqual(quiet.ended, []);
  assert.equal(quiet.checks, 0);
});

test("one viewer's stream ending leaves another viewer's running", async () => {
  const a = guard({ ref: { sub: "alice", sid: "kc-1", iat: Math.floor(T0 / 1000) } });
  const b = guard({
    ref: { sub: "bob", sid: "kc-7", iat: Math.floor(T0 / 1000) },
    expiresAt: T0 + 60 * 60_000,
  });
  revoke({ sub: "alice", sid: "kc-1" });
  await advance(16 * 60_000);
  assert.deepEqual(a.ended, ["revoked"]);
  assert.deepEqual(b.ended, []);
  b.stop();
});

test("the terminal frames are named events the client can tell apart", () => {
  assert.match(sessionExpiredFrame(), new RegExp(`^event: ${SESSION_EXPIRED_EVENT}\\n`));
  assert.match(accessEndedFrame(), new RegExp(`^event: ${ACCESS_ENDED_EVENT}\\n`));
  for (const frame of [sessionExpiredFrame(), accessEndedFrame()]) {
    assert.match(frame, /\ndata: \{[^\n]*\}\n\n$/);
    // The client decides whether to come back; the browser must not.
    assert.doesNotMatch(frame, /retry:/);
  }
});
