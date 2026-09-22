import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  type SourceImpact,
  deleteTombstones,
  describeDeleteConsequence,
  describeImpact,
  fetchSourceImpact,
  impactCounts,
} from "@/lib/source-impact";

const IMPACT: SourceImpact = {
  sourceId: "src-1",
  dashboards: [
    { id: "d1", title: "Ops", panels: [{ id: "p1", title: "Errors" }] },
    {
      id: "d2",
      title: "Latency",
      panels: [
        { id: "p2", title: "p95" },
        { id: "p3", title: "p99" },
      ],
    },
  ],
  referencedByAnyVersion: true,
};

const EMPTY: SourceImpact = {
  sourceId: "src-1",
  dashboards: [],
  referencedByAnyVersion: false,
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(response: Response | (() => never)): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: string) => {
    urls.push(String(input));
    if (typeof response === "function") response();
    return response;
  }) as typeof fetch;
  return urls;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

test("panels are counted across dashboards, not per dashboard", () => {
  assert.deepEqual(impactCounts(IMPACT), { dashboards: 2, panels: 3 });
  assert.deepEqual(impactCounts(EMPTY), { dashboards: 0, panels: 0 });
});

test("the impact reads as a phrase, with singulars where they belong", () => {
  assert.equal(describeImpact(IMPACT), "3 panels across 2 dashboards");
  assert.equal(
    describeImpact({
      sourceId: "src-1",
      dashboards: [{ id: "d1", title: "Ops", panels: [{ id: "p1", title: "Errors" }] }],
      referencedByAnyVersion: true,
    }),
    "1 panel across 1 dashboard",
  );
  assert.equal(describeImpact(EMPTY), "nothing");
});

test("a source only an old version names is tombstoned, and says so", () => {
  const historic: SourceImpact = { ...EMPTY, referencedByAnyVersion: true };
  assert.equal(deleteTombstones(historic), true);
  assert.match(describeDeleteConsequence(historic), /earlier version/);
  assert.match(describeDeleteConsequence(historic), /tombstoned/);
  assert.equal(deleteTombstones(EMPTY), false);
  assert.equal(deleteTombstones(IMPACT), true);
});

test("the delete consequence names the tombstone, not a deletion", () => {
  const sentence = describeDeleteConsequence(IMPACT);
  assert.match(sentence, /3 panels across 2 dashboards/);
  assert.match(sentence, /tombstone/);
  // An unreferenced source really is deleted, and says so.
  assert.match(describeDeleteConsequence(EMPTY), /deleted outright/);
  assert.doesNotMatch(describeDeleteConsequence(EMPTY), /tombstone/);
});

test("impact is read from the body's shape, not trusted wholesale", async () => {
  stubFetch(jsonResponse({ impact: IMPACT }));
  const outcome = await fetchSourceImpact("src-1");
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.ok && outcome.impact, IMPACT);
});

test("a malformed impact body is an error, not a silently empty list", async () => {
  stubFetch(jsonResponse({ impact: { sourceId: "src-1" } }));
  const outcome = await fetchSourceImpact("src-1");
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.error.kind, "unknown");
});

test("the source id is escaped into the path", async () => {
  const urls = stubFetch(jsonResponse({ impact: EMPTY }));
  await fetchSourceImpact("a/b");
  assert.deepEqual(urls, ["/api/sources/a%2Fb/impact"]);
});

test("a refused request surfaces as the API error it was", async () => {
  stubFetch(jsonResponse({ error: "forbidden", kind: "authorization" }, { status: 403 }));
  const outcome = await fetchSourceImpact("src-1");
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.error.kind, "authorization");
});
