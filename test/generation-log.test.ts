import { test } from "node:test";
import assert from "node:assert/strict";
import type { LanguageModelUsage } from "ai";
import {
  catalogHash,
  generationLogLimit,
  generationRow,
  GENERATION_LOG_MAX_PAGE,
  GENERATION_LOG_PAGE,
  type GenerationEvent,
  type GenerationLogRow,
  MAX_LOGGED_PROMPT,
  recordGeneration,
  redactGenerationError,
  redactPrompt,
} from "@/lib/ai/log";
import { authorizedWorkspaces } from "@/lib/auth/authorize";
import { parseGroups } from "@/lib/auth/claims";
import { listGenerationLog } from "@/lib/db/repo";

function event(overrides: Partial<GenerationEvent> = {}): GenerationEvent {
  return {
    workspaceId: "ws-1",
    createdBy: "user-1",
    mode: "dashboard",
    sourceId: "src-1",
    prompt: "Show me p95 latency by route",
    catalog: "http_requests(ts timestamptz, route text, duration_ms double precision)",
    spec: { title: "Service health", panels: [] },
    model: "gpt-4o-mini",
    usage: { inputTokens: 1200, outputTokens: 340 } as LanguageModelUsage,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Redaction                                                                  */
/* -------------------------------------------------------------------------- */

test("a connection string in a prompt is stored without its password", () => {
  const secret = "hunter2superlongpassword";
  const row = generationRow(
    event({
      prompt: `Build a dashboard against postgres://metrics_ro:${secret}@db.internal:5432/metrics`,
    }),
  );
  assert.ok(!row.promptRedacted.includes(secret));
  assert.match(row.promptRedacted, /\[redacted\]/);
  // The shape of the prompt survives: the point is to be able to read it back.
  assert.match(row.promptRedacted, /postgres:\/\/metrics_ro:/);
  assert.match(row.promptRedacted, /db\.internal:5432\/metrics/);
});

test("credential-shaped assignments are redacted", () => {
  const cases: [string, string][] = [
    ["password=hunter2", "hunter2"],
    ['{"api_key": "abcd1234efgh5678"}', "abcd1234efgh5678"],
    ["Authorization: Bearer abcdefghijklmnop", "abcdefghijklmnop"],
    ["TS_METRICS_PASSWORD=hunter2", "hunter2"],
    ['"OPENAI_API_KEY": "zzzz-not-a-real-key"', "zzzz-not-a-real-key"],
    ["PROM_TOKEN=shhh-dont-tell", "shhh-dont-tell"],
  ];
  for (const [prompt, secret] of cases) {
    const out = redactPrompt(prompt);
    assert.ok(!out.includes(secret), `${prompt} -> ${out}`);
  }
});

test("long opaque runs a prompt has no business carrying are redacted", () => {
  const hex = "a".repeat(40);
  const b64 = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5";
  assert.ok(!redactPrompt(`token ${hex}`).includes(hex));
  assert.ok(!redactPrompt(`cookie ${b64}`).includes(b64));
});

test("an ordinary prompt survives redaction unchanged", () => {
  const prompt =
    "Show p95 latency by route over the last 6 hours, and a stat for error rate";
  assert.equal(redactPrompt(prompt), prompt);
});

test("a prompt past the cap is clamped rather than stored whole", () => {
  const row = generationRow(event({ prompt: "a".repeat(MAX_LOGGED_PROMPT + 500) }));
  assert.ok(row.promptRedacted.length < MAX_LOGGED_PROMPT + 100);
  assert.match(row.promptRedacted, /chars\)$/);
});

test("an error message is redacted and a non-error is still readable", () => {
  assert.equal(redactGenerationError(undefined), null);
  assert.equal(redactGenerationError(null), null);
  assert.equal(
    redactGenerationError(new Error("could not connect")),
    "could not connect",
  );
  const out = redactGenerationError(
    new Error("connect failed for postgres://ro:hunter2secretvalue@db:5432/m"),
  );
  assert.ok(out && !out.includes("hunter2secretvalue"));
});

/* -------------------------------------------------------------------------- */
/* The row                                                                    */
/* -------------------------------------------------------------------------- */

test("the catalog is kept as a hash, never as text", () => {
  const catalog = "http_requests(ts timestamptz, route text)";
  const row = generationRow(event({ catalog }));
  assert.ok(row.catalogHash);
  assert.notEqual(row.catalogHash, catalog);
  assert.ok(!JSON.stringify(row).includes("http_requests"));
  // Same catalog, same hash — that is the whole question the column answers.
  assert.equal(row.catalogHash, catalogHash(catalog));
  assert.notEqual(catalogHash(catalog), catalogHash(`${catalog} `));
});

test("a source draft has no catalog and no source", () => {
  const row = generationRow(
    event({ mode: "source-draft", sourceId: null, catalog: null }),
  );
  assert.equal(row.catalogHash, null);
  assert.equal(row.sourceId, null);
  assert.equal(row.mode, "source-draft");
});

test("a failed run records the error and no spec", () => {
  const row = generationRow(
    event({ spec: undefined, error: new Error("schema validation failed") }),
  );
  assert.equal(row.spec, null);
  assert.equal(row.error, "schema validation failed");
});

test("token counts come from the usage, and a missing usage is zero", () => {
  assert.deepEqual(
    { i: generationRow(event()).inputTokens, o: generationRow(event()).outputTokens },
    { i: 1200, o: 340 },
  );
  const none = generationRow(event({ usage: undefined }));
  assert.equal(none.inputTokens, 0);
  assert.equal(none.outputTokens, 0);
});

test("attempts is at least one, whatever the caller says", () => {
  assert.equal(generationRow(event()).attempts, 1);
  assert.equal(generationRow(event({ attempts: 0 })).attempts, 1);
  assert.equal(generationRow(event({ attempts: 3 })).attempts, 3);
});

test("a model id the provider did not report falls back rather than being empty", () => {
  assert.ok(generationRow(event({ model: "" })).model.length > 0);
});

/* -------------------------------------------------------------------------- */
/* Writing                                                                    */
/* -------------------------------------------------------------------------- */

test("recordGeneration writes one redacted row and passes the retention window", async () => {
  const written: { row: GenerationLogRow; retentionDays: number }[] = [];
  recordGeneration(
    event({ prompt: "password=hunter2 and show me latency" }),
    async (row, retentionDays) => {
      written.push({ row, retentionDays });
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(written.length, 1);
  assert.ok(!written[0]?.row.promptRedacted.includes("hunter2"));
  assert.equal(typeof written[0]?.retentionDays, "number");
});

test("a write that fails never reaches the caller", async () => {
  recordGeneration(event(), async () => {
    throw new Error("config store is down");
  });
  await new Promise((resolve) => setImmediate(resolve));
  // Reaching here without an unhandled rejection is the assertion.
  assert.ok(true);
});

/* -------------------------------------------------------------------------- */
/* Read parameters                                                            */
/* -------------------------------------------------------------------------- */

test("the limit parameter is clamped and never trusted", () => {
  assert.equal(generationLogLimit(null), GENERATION_LOG_PAGE);
  assert.equal(generationLogLimit("nonsense"), GENERATION_LOG_PAGE);
  assert.equal(generationLogLimit("0"), GENERATION_LOG_PAGE);
  assert.equal(generationLogLimit("-5"), GENERATION_LOG_PAGE);
  assert.equal(generationLogLimit("10"), 10);
  assert.equal(generationLogLimit("100000"), GENERATION_LOG_MAX_PAGE);
});

/* -------------------------------------------------------------------------- */
/* Who may read it                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The route's whole access decision is `authorizedWorkspaces(identity,
 * "source:manage", ?workspaceId=)`, so that expression is what is pinned here:
 * a viewer and an editor read nothing, a source-admin reads their own
 * workspace, and the query parameter narrows rather than grants.
 */
test("the generation log is readable by a source-admin, not by a viewer or editor", () => {
  const scope = (groups: string[], only?: string | null) =>
    authorizedWorkspaces(parseGroups("u1", groups), "source:manage", only);

  assert.deepEqual(scope(["/workspaces/w/viewer"]), []);
  assert.deepEqual(scope(["/workspaces/w/editor"]), []);
  assert.deepEqual(scope(["/workspaces/w/source-admin"]), ["w"]);

  // A workspace the caller has no claim in narrows the answer to nothing.
  assert.deepEqual(scope(["/workspaces/w/source-admin"], "other"), []);
  assert.deepEqual(scope(["/workspaces/w/source-admin"], "w"), ["w"]);

  // Source-admin in one workspace, editor in another: only the first is read.
  assert.deepEqual(scope(["/workspaces/w/source-admin", "/workspaces/x/editor"]), ["w"]);
});

test("listGenerationLog answers nothing for an empty workspace scope", async () => {
  // A viewer's scope is the empty list, and that must not become an unscoped
  // query: the repo answers without ever reaching the database.
  assert.deepEqual(await listGenerationLog([], { limit: 50, retentionDays: 30 }), []);
});
