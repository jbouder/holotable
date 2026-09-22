import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { Environment } from "@/lib/config";
import {
  checkReadiness,
  readinessHttpStatus,
  resetJwksCacheForTests,
  type ReadinessDeps,
} from "@/lib/readiness";
import { beginDrain, resetDrainForTests } from "@/lib/shutdown";
import { dynamic } from "@/app/api/ready/route";

/**
 * Readiness decides whether an instance is sent traffic, so the tests that
 * matter are the ones about *which* failure takes it out of rotation and
 * about what the body is allowed to say.
 */

/** A configured, healthy environment. The values are the ones a leak would expose. */
const ENV: Environment = {
  DATABASE_URL: "postgresql://holotable:hunter2@db.internal:5432/holotable",
  OIDC_JWKS_URL: "https://kc.internal/realms/holotable/protocol/openid-connect/certs",
  AI_PROVIDER: "openai-compatible",
  AI_MODEL: "openai/gpt-4o-mini",
  OPENAI_API_KEY: "sk-secret-value",
};

const healthy: ReadinessDeps = {
  env: ENV,
  pingDatabase: async () => {},
  fetchJwks: async () => ({ ok: true, status: 200 }),
};

beforeEach(() => {
  resetDrainForTests();
  resetJwksCacheForTests();
});

describe("checkReadiness", () => {
  it("is ready and serves traffic when every dependency answers", async () => {
    const report = await checkReadiness(healthy);
    assert.equal(report.status, "ready");
    assert.equal(readinessHttpStatus(report.status), 200);
    assert.deepEqual(report.checks.database, { status: "ok" });
    assert.equal(report.checks.identityProvider.status, "ok");
    assert.equal(report.checks.aiProvider.status, "ok");
  });

  it("is not ready, naming the dependency, when the config store is unreachable", async () => {
    // `pg` reports a refused connection as an AggregateError, one entry per
    // address tried, with the useful part in `code`.
    const refused = new AggregateError(
      [
        Object.assign(new Error("connect ECONNREFUSED 10.0.0.4:5432"), {
          code: "ECONNREFUSED",
        }),
      ],
      "",
    );
    const report = await checkReadiness({
      ...healthy,
      pingDatabase: () => Promise.reject(refused),
    });
    assert.equal(report.status, "not_ready");
    assert.equal(readinessHttpStatus(report.status), 503);
    assert.deepEqual(report.checks.database, {
      status: "failed",
      reason: "ECONNREFUSED",
    });
  });

  it("is not ready when DATABASE_URL is unset, without probing", async () => {
    let probed = false;
    const report = await checkReadiness({
      ...healthy,
      env: { ...ENV, DATABASE_URL: undefined },
      pingDatabase: async () => {
        probed = true;
      },
    });
    assert.equal(report.status, "not_ready");
    assert.equal(report.checks.database.reason, "DATABASE_URL is not set");
    assert.equal(probed, false);
  });

  it("gives up on a database that never answers", async () => {
    const report = await checkReadiness({
      ...healthy,
      pingDatabase: () => new Promise<void>(() => {}),
    });
    assert.equal(report.status, "not_ready");
    assert.equal(report.checks.database.reason, "TIMEOUT");
  });

  it("never puts a connection string, host, or credential in the body", async () => {
    const report = await checkReadiness({
      ...healthy,
      pingDatabase: () =>
        Promise.reject(
          Object.assign(
            new Error(
              "password authentication failed for user holotable at db.internal:5432",
            ),
            { code: "28P01" },
          ),
        ),
      // What `fetch` actually throws: a bare TypeError wrapping the cause.
      fetchJwks: () =>
        Promise.reject(
          Object.assign(new TypeError("fetch failed"), {
            cause: Object.assign(new Error("connect ECONNREFUSED kc.internal:443"), {
              code: "ECONNREFUSED",
            }),
          }),
        ),
    });
    assert.equal(report.checks.database.reason, "28P01");
    assert.equal(report.checks.identityProvider.reason, "ECONNREFUSED");
    const body = JSON.stringify(report);
    for (const secret of [
      "hunter2",
      "db.internal",
      "kc.internal",
      "sk-secret-value",
      "postgresql://",
      "holotable",
    ]) {
      assert.ok(!body.includes(secret), `readiness body leaked ${secret}: ${body}`);
    }
  });

  it("caches the realm check so a probe loop does not hammer Keycloak", async () => {
    let fetches = 0;
    const deps: ReadinessDeps = {
      ...healthy,
      fetchJwks: async () => {
        fetches += 1;
        return { ok: true, status: 200 };
      },
    };
    const first = await checkReadiness(deps);
    const second = await checkReadiness(deps);
    assert.equal(fetches, 1);
    assert.equal(first.checks.identityProvider.cached, undefined);
    assert.equal(second.checks.identityProvider.cached, true);
    assert.equal(second.checks.identityProvider.status, "ok");
  });

  it("re-probes the realm once the cached answer expires", async () => {
    let fetches = 0;
    let clock = 1_000;
    const deps: ReadinessDeps = {
      ...healthy,
      now: () => clock,
      fetchJwks: async () => {
        fetches += 1;
        return { ok: true, status: 200 };
      },
    };
    await checkReadiness(deps);
    clock += 61_000;
    await checkReadiness(deps);
    assert.equal(fetches, 2);
  });

  it("re-probes when the realm URL changes rather than reusing the cache", async () => {
    let fetches = 0;
    const fetchJwks = async () => {
      fetches += 1;
      return { ok: true, status: 200 };
    };
    await checkReadiness({ ...healthy, fetchJwks });
    await checkReadiness({
      ...healthy,
      fetchJwks,
      env: { ...ENV, OIDC_JWKS_URL: "https://other.example/certs" },
    });
    assert.equal(fetches, 2);
  });

  it("keeps serving traffic when only the realm is down", async () => {
    // Sessions are first-party tokens, so a realm outage stops new logins but
    // leaves signed-in users working. Draining every instance for that would
    // turn a login outage into a total one.
    const report = await checkReadiness({
      ...healthy,
      fetchJwks: async () => ({ ok: false, status: 503 }),
    });
    assert.equal(report.status, "degraded");
    assert.equal(readinessHttpStatus(report.status), 200);
    assert.deepEqual(report.checks.identityProvider, {
      status: "failed",
      reason: "http_503",
    });
  });

  it("skips the realm check when no realm is configured", async () => {
    const report = await checkReadiness({
      ...healthy,
      env: { ...ENV, OIDC_JWKS_URL: undefined },
      fetchJwks: async () => {
        throw new Error("must not probe");
      },
    });
    assert.equal(report.status, "ready");
    assert.equal(report.checks.identityProvider.status, "skipped");
  });

  it("reports missing AI configuration as degraded, never by calling a provider", async () => {
    for (const [env, reason] of [
      [{ ...ENV, AI_MODEL: undefined }, "AI_MODEL is not set"],
      [{ ...ENV, OPENAI_API_KEY: undefined }, "OPENAI_API_KEY is not set"],
      [
        { ...ENV, AI_PROVIDER: "gateway", AI_GATEWAY_API_KEY: undefined },
        "AI_GATEWAY_API_KEY is not set",
      ],
      [{ ...ENV, AI_PROVIDER: "wat" }, "AI_PROVIDER is not recognized"],
    ] as Array<[Environment, string]>) {
      const report = await checkReadiness({ ...healthy, env });
      assert.equal(report.status, "degraded");
      assert.equal(readinessHttpStatus(report.status), 200);
      assert.deepEqual(report.checks.aiProvider, { status: "failed", reason });
    }
  });

  it("is a gateway deployment's business alone whether the gateway key is set", async () => {
    const report = await checkReadiness({
      ...healthy,
      env: { ...ENV, AI_PROVIDER: "gateway", AI_GATEWAY_API_KEY: "gw-key" },
    });
    assert.equal(report.checks.aiProvider.status, "ok");
  });

  it("fails while draining even though every dependency is healthy", async () => {
    beginDrain();
    const report = await checkReadiness(healthy);
    assert.equal(report.status, "draining");
    assert.equal(readinessHttpStatus(report.status), 503);
    assert.equal(report.checks.database.status, "ok");
  });
});

describe("GET /api/ready", () => {
  it("is never prerendered", () => {
    assert.equal(dynamic, "force-dynamic");
  });
});
