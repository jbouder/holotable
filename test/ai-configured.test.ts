import { test } from "node:test";
import assert from "node:assert/strict";
import { aiConfigProblem, aiUnavailable } from "@/lib/ai/configured";

test("a configured model is no problem", () => {
  assert.equal(aiConfigProblem({ AI_MODEL: "m", OPENAI_API_KEY: "k" }), null);
  assert.equal(
    aiConfigProblem({ AI_PROVIDER: "gateway", AI_MODEL: "m", AI_GATEWAY_API_KEY: "k" }),
    null,
  );
  assert.equal(aiUnavailable({ AI_MODEL: "m", OPENAI_API_KEY: "k" }), null);
  // The recorded model (#88) has no model id or key to be missing.
  assert.equal(aiConfigProblem({ AI_PROVIDER: "stub" }), null);
});

test("the missing variable is named, never a value", () => {
  assert.equal(aiConfigProblem({}), "AI_MODEL");
  assert.equal(aiConfigProblem({ AI_MODEL: "m" }), "OPENAI_API_KEY");
  assert.equal(
    aiConfigProblem({ AI_PROVIDER: "gateway", AI_MODEL: "m" }),
    "AI_GATEWAY_API_KEY",
  );
  assert.equal(aiConfigProblem({ AI_PROVIDER: "x", AI_MODEL: "m" }), "AI_PROVIDER");
});

test("the notice says what to set, and leaks no configured value", () => {
  const message = aiUnavailable({
    OPENAI_API_KEY: "sk-secret",
    OPENAI_BASE_URL: "https://x",
  });
  assert.ok(message);
  assert.match(message, /No model configured/);
  assert.match(message, /AI_MODEL/);
  assert.doesNotMatch(message, /sk-secret|https:\/\/x/);
});
