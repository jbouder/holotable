import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GET, dynamic } from "@/app/api/health/route";
import { appCommit, appVersion } from "@/lib/version";

/**
 * The Dockerfile HEALTHCHECK probes this route, so a healthy process must
 * always answer 200 and the answer must never be cached in front of it.
 */
describe("GET /api/health", () => {
  it("answers 200 with status ok and no caching", async () => {
    const response = GET();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      status: "ok",
      version: appVersion,
      commit: appCommit,
    });
  });

  it("names the build so an operator can tell which one answered", async () => {
    const body = (await GET().json()) as { version: string; commit: string };
    // The version falls back to package.json; the commit to "unknown". Both
    // are always present and always strings, so a probe can log them blind.
    assert.match(body.version, /^\d+\.\d+\.\d+/);
    assert.ok(body.commit.length > 0);
  });

  it("is never prerendered", () => {
    assert.equal(dynamic, "force-dynamic");
  });
});
