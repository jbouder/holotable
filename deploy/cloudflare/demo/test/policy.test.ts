import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bucketFor,
  clientKey,
  demoLimits,
  forContainer,
  limitedResponse,
  startingResponse,
  wantsDocument,
} from "../src/policy.ts";

const URL_ = "https://holotable-demo.vibeproject.workers.dev";
const req = (path: string, init: RequestInit = {}) => new Request(`${URL_}${path}`, init);

test("API writes count against the write limit; everything else is a read", () => {
  for (const [method, path] of [
    ["POST", "/api/query"],
    ["POST", "/api/generate"],
    ["PUT", "/api/dashboards/x"],
    ["DELETE", "/api/dashboards/x"],
    ["POST", "/api/auth/logout"],
  ]) {
    assert.equal(bucketFor(req(path, { method })), "write", `${method} ${path}`);
  }
  for (const [method, path] of [
    ["GET", "/dashboards"],
    ["GET", "/api/dashboards"],
    ["GET", "/api/dashboards/x/stream"],
    ["GET", "/_next/static/chunk.js"],
    ["HEAD", "/api/health"],
    ["POST", "/dashboards"],
  ]) {
    assert.equal(bucketFor(req(path, { method })), "read", `${method} ${path}`);
  }
});

test("the limit key is Cloudflare's client IP, never X-Forwarded-For", () => {
  assert.equal(
    clientKey(
      req("/", {
        headers: { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "1.2.3.4" },
      }),
    ),
    "203.0.113.7",
  );
  assert.equal(
    clientKey(req("/", { headers: { "x-forwarded-for": "1.2.3.4" } })),
    "unknown",
  );
});

test("a navigation gets a page; fetch, SSE and assets get JSON", () => {
  assert.equal(
    wantsDocument(req("/", { headers: { "sec-fetch-dest": "document" } })),
    true,
  );
  assert.equal(wantsDocument(req("/", { headers: { accept: "text/html,*/*" } })), true);
  assert.equal(
    wantsDocument(
      req("/api/x", { headers: { "sec-fetch-dest": "empty", accept: "text/html" } }),
    ),
    false,
  );
  assert.equal(
    wantsDocument(req("/api/x", { headers: { accept: "text/event-stream" } })),
    false,
  );
  assert.equal(
    wantsDocument(req("/", { method: "POST", headers: { accept: "text/html" } })),
    false,
  );
});

test("the container sees the visitor's scheme and host, not the client's claims", () => {
  const forwarded = forContainer(
    req("/dashboards?x=1", {
      headers: {
        "x-forwarded-proto": "http",
        "x-forwarded-host": "evil.example",
        "x-forwarded-for": "1.2.3.4",
        "cf-connecting-ip": "203.0.113.7",
        cookie: "holotable_session=abc",
      },
    }),
  );
  assert.equal(forwarded.headers.get("x-forwarded-proto"), "https");
  assert.equal(
    forwarded.headers.get("x-forwarded-host"),
    "holotable-demo.vibeproject.workers.dev",
  );
  assert.equal(forwarded.headers.get("x-forwarded-for"), "203.0.113.7");
  assert.equal(forwarded.headers.get("cookie"), "holotable_session=abc");
  assert.equal(new URL(forwarded.url).pathname, "/dashboards");
});

test("the starting page refreshes itself and is never cached", async () => {
  const page = startingResponse(
    req("/", { headers: { "sec-fetch-dest": "document" } }),
    30,
  );
  assert.equal(page.status, 503);
  assert.equal(page.headers.get("refresh"), "3");
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(await page.text(), /about 30 seconds/);

  const api = startingResponse(req("/api/dashboards"), 30);
  assert.equal(api.status, 503);
  assert.equal(api.headers.get("retry-after"), "3");
  assert.equal(((await api.json()) as { kind: string }).kind, "unavailable");
});

test("over the limit is a 429 with Retry-After", async () => {
  const write = limitedResponse(req("/api/query", { method: "POST" }), "write");
  assert.equal(write.status, 429);
  assert.equal(write.headers.get("retry-after"), "60");
  assert.equal(((await write.json()) as { kind: string }).kind, "rate_limited");
  const page = limitedResponse(
    req("/", { headers: { "sec-fetch-dest": "document" } }),
    "read",
  );
  assert.equal(page.status, 429);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
});

test("demo model limits default low and never disable", () => {
  assert.deepEqual(demoLimits({}), {
    LLM_RATE_PER_MINUTE: "5",
    LLM_DAILY_TOKEN_BUDGET: "300000",
  });
  assert.deepEqual(
    demoLimits({ LLM_RATE_PER_MINUTE: "3", LLM_DAILY_TOKEN_BUDGET: "100000" }),
    {
      LLM_RATE_PER_MINUTE: "3",
      LLM_DAILY_TOKEN_BUDGET: "100000",
    },
  );
  // 0 means "no limit" to the app, so it is refused here.
  assert.deepEqual(
    demoLimits({ LLM_RATE_PER_MINUTE: "0", LLM_DAILY_TOKEN_BUDGET: "-1" }),
    {
      LLM_RATE_PER_MINUTE: "5",
      LLM_DAILY_TOKEN_BUDGET: "300000",
    },
  );
});
