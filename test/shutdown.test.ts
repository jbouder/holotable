import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  inFlightCount,
  isDraining,
  isShuttingDown,
  onDrain,
  resetDrainForTests,
  shutdown,
  trackInFlight,
} from "@/lib/shutdown";
import { DRAIN_EVENT, drainFrame } from "@/lib/sse";
import { activePollerCount, getPoller, stopAllPollers } from "@/lib/poller/registry";
import { checkReadiness, readinessHttpStatus } from "@/lib/readiness";
import { GET as health } from "@/app/api/health/route";
import type { Dashboard } from "@/lib/ir";
import type { Environment } from "@/lib/config";

/**
 * Graceful shutdown is only ever exercised for real by a rolling deploy, so
 * the tests are about the order and the bounds: readiness fails first, the
 * process waits for work but not forever, and it always leaves with 0.
 */

/** A shutdown with nothing real behind it: no pollers to stop, no pool to close. */
const isolated = {
  stopPollers: () => {},
  closePool: async () => {},
  log: () => {},
};

/** Never resolves. Stands in for a query that outlives the grace period. */
function hang(): Promise<void> {
  return new Promise<void>(() => {});
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  resetDrainForTests();
});

describe("shutdown", () => {
  it("sets the drain flag before it waits for anything", async () => {
    const work = deferred<void>();
    void trackInFlight(() => work.promise);

    const done = shutdown({ ...isolated, graceMs: 1_000 });
    // Not awaited: the flag must already be set on the tick the signal arrived,
    // or a probe in flight would still answer "ready".
    assert.equal(isDraining(), true);
    assert.equal(isShuttingDown(), true);

    work.resolve();
    assert.equal(await done, 0);
  });

  it("takes the instance out of rotation while liveness stays green", async () => {
    const env: Environment = {
      DATABASE_URL: "postgresql://holotable:pw@db.internal:5432/holotable",
      AI_MODEL: "openai/gpt-4o-mini",
      OPENAI_API_KEY: "sk-test",
    };
    const deps = { env, pingDatabase: async () => {} };

    const before = await checkReadiness(deps);
    assert.equal(readinessHttpStatus(before.status), 200);

    assert.equal(await shutdown({ ...isolated, graceMs: 100 }), 0);

    const after = await checkReadiness(deps);
    assert.equal(after.status, "draining");
    assert.equal(readinessHttpStatus(after.status), 503);
    // Liveness must not follow readiness down: restarting a process that is on
    // its way out is the wrong cure, and the orchestrator would do exactly that.
    assert.equal(health().status, 200);
  });

  it("waits for in-flight queries, then closes the pool", async () => {
    const order: string[] = [];
    const work = deferred<void>();
    void trackInFlight(async () => {
      await work.promise;
      order.push("query");
    });

    const done = shutdown({
      stopPollers: () => {
        order.push("pollers");
      },
      closePool: async () => {
        order.push("pool");
      },
      graceMs: 1_000,
      log: () => {},
    });

    // The pool must not close under a running query.
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(order, ["pollers"]);

    work.resolve();
    assert.equal(await done, 0);
    assert.deepEqual(order, ["pollers", "query", "pool"]);
    assert.equal(inFlightCount(), 0);
  });

  it("gives up on a query that outruns the grace period and still exits 0", async () => {
    void trackInFlight(hang);
    const messages: string[] = [];

    const startedAt = Date.now();
    const code = await shutdown({
      ...isolated,
      graceMs: 60,
      log: (m) => messages.push(m),
    });
    const elapsed = Date.now() - startedAt;

    assert.equal(code, 0);
    assert.ok(elapsed < 2_000, `shutdown took ${elapsed}ms, well past its budget`);
    assert.match(messages.join("\n"), /grace period of 60ms expired/);
  });

  it("counts work as finished even when it throws", async () => {
    await assert.rejects(
      trackInFlight(async () => {
        throw new Error("query failed");
      }),
      /query failed/,
    );
    await assert.rejects(
      trackInFlight(() => {
        throw new Error("thrown before the promise");
      }),
      /thrown before the promise/,
    );
    assert.equal(inFlightCount(), 0, "a failed query must not block the drain");
  });

  it("runs each drain hook once, and a throwing one does not stop the rest", async () => {
    const ran: string[] = [];
    onDrain(() => {
      ran.push("first");
      throw new Error("hook failed");
    });
    onDrain(async () => {
      ran.push("second");
    });

    let poolClosed = false;
    const code = await shutdown({
      stopPollers: () => {},
      closePool: async () => {
        poolClosed = true;
      },
      graceMs: 1_000,
      log: () => {},
    });

    assert.equal(code, 0);
    assert.deepEqual(ran, ["first", "second"]);
    assert.equal(poolClosed, true);
  });

  it("does not run a hook that unregistered itself", async () => {
    let ran = false;
    const unregister = onDrain(() => {
      ran = true;
    });
    unregister();

    await shutdown({ ...isolated, graceMs: 100 });
    assert.equal(ran, false);
  });

  it("drains once however many signals arrive", async () => {
    let stops = 0;
    const opts = {
      stopPollers: () => {
        stops += 1;
      },
      closePool: async () => {},
      graceMs: 100,
      log: () => {},
    };

    const [a, b] = await Promise.all([shutdown(opts), shutdown(opts)]);
    assert.equal(a, 0);
    assert.equal(b, 0);
    assert.equal(await shutdown(opts), 0);
    assert.equal(stops, 1);
  });
});

describe("stopAllPollers", () => {
  const spec: Dashboard = {
    title: "shutdown",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 60_000,
    panels: [],
  };

  it("stops every poller so no query is issued after the drain begins", () => {
    const a = getPoller("dash-drain-a", 1, "ws1", spec, async () => []);
    const b = getPoller("dash-drain-b", 1, "ws1", spec, async () => []);
    a.subscribe(() => {});
    b.subscribe(() => {});
    assert.equal(a.isRunning, true);

    stopAllPollers();

    assert.equal(a.isRunning, false);
    assert.equal(b.isRunning, false);
    assert.equal(activePollerCount(), 0);
  });
});

describe("drainFrame", () => {
  it("hands the browser a reconnect delay and a named terminal event", () => {
    const frame = drainFrame(() => 0);
    assert.match(frame, /^retry: \d+\n/);
    assert.ok(frame.includes(`event: ${DRAIN_EVENT}\n`));
    assert.ok(frame.endsWith("\n\n"), "an SSE frame ends with a blank line");
  });

  it("spreads the reconnects so subscribers do not all come back at once", () => {
    const retryOf = (frame: string) => Number(/^retry: (\d+)/.exec(frame)?.[1]);
    const low = retryOf(drainFrame(() => 0));
    const high = retryOf(drainFrame(() => 0.999));

    assert.ok(Number.isInteger(low) && Number.isInteger(high));
    assert.ok(low >= 1_000, "a delay under a second is not a spread");
    assert.ok(high > low, "the delay must vary between subscribers");
    assert.ok(high <= 30_000, "a delay this long looks like an outage to a viewer");
  });
});
