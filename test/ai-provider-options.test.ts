import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenAI } from "@ai-sdk/openai";
import { type LanguageModel, streamObject } from "ai";
import { PROVIDER_OPTIONS } from "@/lib/ai/provider";
import { DashboardGenerationSchema } from "@/lib/ir";

/*
 * OpenAI's strict structured outputs refuse a schema with optional fields, so
 * every generation against an OpenAI model failed before it started (#336).
 * The calls carry PROVIDER_OPTIONS, which turn strict off; these read the
 * request the provider would send and check it says so.
 */

/** The JSON body of the one request `model` makes, without sending it anywhere. */
async function requestBody(make: (fetch: typeof globalThis.fetch) => LanguageModel) {
  let body: Record<string, unknown> | undefined;
  const capture: typeof globalThis.fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ error: { message: "stop here" } }), {
      status: 400,
    });
  };
  const result = streamObject({
    model: make(capture),
    maxRetries: 0,
    providerOptions: PROVIDER_OPTIONS,
    schema: DashboardGenerationSchema,
    prompt: "x",
    onError: () => {},
  });
  for await (const _ of result.textStream) {
    // drain until the refusal ends it
  }
  if (!body) throw new Error("no request was made");
  return body;
}

const provider = (fetch: typeof globalThis.fetch) =>
  createOpenAI({ apiKey: "test", baseURL: "http://provider.test/v1", fetch });

test("the Responses API is asked for non-strict structured output", async () => {
  const body = await requestBody((fetch) => provider(fetch)("gpt-test"));
  const format = (body.text as { format: { type: string; strict: boolean } }).format;
  assert.equal(format.type, "json_schema");
  assert.equal(format.strict, false);
});

test("Chat Completions (OPENAI_API=chat) is asked for non-strict structured output", async () => {
  const body = await requestBody((fetch) => provider(fetch).chat("gpt-test"));
  const format = body.response_format as { json_schema: { strict: boolean } };
  assert.equal(format.json_schema.strict, false);
});
