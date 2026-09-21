import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GET, dynamic } from "@/app/api/health/route";

/**
 * The Dockerfile HEALTHCHECK probes this route, so a healthy process must
 * always answer 200 and the answer must never be cached in front of it.
 */
describe("GET /api/health", () => {
  it("answers 200 with status ok and no caching", async () => {
    const response = GET();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { status: "ok" });
  });

  it("is never prerendered", () => {
    assert.equal(dynamic, "force-dynamic");
  });
});
