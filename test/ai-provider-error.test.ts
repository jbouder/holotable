import assert from "node:assert/strict";
import { test } from "node:test";
import { APICallError, type LanguageModel, streamObject } from "ai";
import { HttpError } from "@/lib/auth/authorize";
import { ModelTimeoutError } from "@/lib/ai/invoke";
import {
  isProtocolMismatch,
  logModelErrors,
  PROTOCOL_MISMATCH_MESSAGE,
  providerErrorMessage,
  providerHttpError,
  textResponseOnceStarted,
} from "@/lib/ai/provider-error";
import { stubModel } from "@/lib/ai/stub";
import { DashboardGenerationSchema } from "@/lib/ir";
import { createLogger, runWithRequest, setLogger } from "@/lib/log";

/*
 * Provider failures, as an author sees them (#337): a sentence that names the
 * setting to change, never the provider's own reply, and an error response
 * rather than an empty answer.
 */

function apiError(statusCode: number, message: string, responseBody?: string) {
  return new APICallError({
    message,
    url: "https://provider.test/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
    responseBody,
  });
}

/** What OpenCode Zen answers for a listed model that does not speak the protocol. */
const MISMATCH = apiError(
  400,
  "Model does not support this protocol.",
  '{"error":{"message":"Model does not support this protocol."}}',
);

test("a protocol mismatch is recognized, in the message or the body", () => {
  assert.equal(isProtocolMismatch(MISMATCH), true);
  assert.equal(
    isProtocolMismatch(apiError(400, "Bad Request", '{"error":"unsupported protocol"}')),
    true,
  );
  assert.equal(isProtocolMismatch(apiError(500, "Internal Server Error")), false);
  assert.equal(
    isProtocolMismatch(new Error("Model does not support this protocol.")),
    false,
  );
});

test("a mismatch names AI_MODEL and OPENAI_API", () => {
  const message = providerErrorMessage(MISMATCH);
  assert.equal(message, PROTOCOL_MISMATCH_MESSAGE);
  assert.match(message, /AI_MODEL/);
  assert.match(message, /OPENAI_API/);
});

test("any other refusal gives the status, never the provider's reply", () => {
  const leaky = apiError(
    401,
    "Incorrect API key provided: sk-proj-abc123",
    '{"key":"sk-proj-abc123"}',
  );
  const message = providerErrorMessage(leaky);
  assert.match(message, /HTTP 401/);
  assert.doesNotMatch(message, /sk-proj/);
});

test("a timeout keeps its own message and is a 504; the rest are 502s", () => {
  const timeout = providerHttpError(new ModelTimeoutError(45_000));
  assert.equal(timeout.status, 504);
  assert.match(timeout.message, /45000ms/);
  const mismatch = providerHttpError(MISMATCH);
  assert.equal(mismatch.status, 502);
  assert.equal(mismatch.kind, "infrastructure");
});

type V4 = Extract<LanguageModel, { specificationVersion: "v4" }>;

function refusing(error: unknown): V4 {
  return {
    specificationVersion: "v4",
    provider: "x",
    modelId: "x",
    supportedUrls: {},
    doGenerate: () => Promise.reject(error),
    doStream: () => Promise.reject(error),
  };
}

/** One that starts answering, then fails partway. */
function failingMidway(error: unknown): V4 {
  return {
    ...refusing(error),
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "1" });
          controller.enqueue({ type: "text-delta", id: "1", delta: '{"title":' });
          controller.enqueue({ type: "error", error });
          controller.close();
        },
      }),
    }),
  };
}

const stream = (model: LanguageModel, onError = logModelErrors()) =>
  streamObject({
    model,
    maxRetries: 0,
    schema: DashboardGenerationSchema,
    prompt: "Create a dashboard for this request: checkout",
    onError,
  });

/** The JSON lines written while `fn` runs, and what reached the console. */
async function captured(fn: () => Promise<void>) {
  const lines: Record<string, unknown>[] = [];
  const restore = setLogger(
    createLogger({
      level: "debug",
      format: "json",
      sink: (l) => lines.push(JSON.parse(l)),
    }),
  );
  const consoleError = console.error;
  const printed: unknown[][] = [];
  console.error = (...args: unknown[]) => printed.push(args);
  try {
    await fn();
  } finally {
    console.error = consoleError;
    restore();
  }
  return { lines, printed };
}

const CONTEXT = { requestId: "req-1", route: "generate", method: "POST" };

test("a refused generation becomes an error response before anything streams", async () => {
  const quiet = () => {};
  await assert.rejects(
    textResponseOnceStarted(stream(refusing(MISMATCH), quiet)),
    (err) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 502);
      assert.equal(err.message, PROTOCOL_MISMATCH_MESSAGE);
      return true;
    },
  );
});

test("a generation that starts streams in full, as toTextStreamResponse would", async () => {
  const response = await textResponseOnceStarted(stream(stubModel()), { "X-Test": "1" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(response.headers.get("x-test"), "1");
  const body = await response.text();
  assert.ok(body.length > 0);
  assert.equal(body, await stream(stubModel()).toTextStreamResponse().text());
});

test("a refusal is logged once, with the request's context, and nothing is printed raw", async () => {
  const { lines, printed } = await captured(async () => {
    const result = runWithRequest(CONTEXT, () => stream(refusing(MISMATCH)));
    // Read outside the request's context, as Next reads a response body.
    await textResponseOnceStarted(result).catch(() => {});
  });
  assert.equal(printed.length, 0);
  const failed = lines.filter((l) => l.msg === "model.request_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].requestId, "req-1");
  assert.equal(failed[0].status, 400);
  assert.equal(failed[0].protocolMismatch, true);
  // The error's name and message, never the request it carried.
  assert.doesNotMatch(JSON.stringify(failed[0]), /requestBodyValues|checkout/);
});

test("a failure after output has started is logged too", async () => {
  const { lines, printed } = await captured(async () => {
    const result = runWithRequest(CONTEXT, () => stream(failingMidway(MISMATCH)));
    const response = await textResponseOnceStarted(result);
    await response.text();
  });
  assert.equal(printed.length, 0);
  const failed = lines.filter((l) => l.msg === "model.request_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].requestId, "req-1");
});

test("an aborted call is not logged as a failure", async () => {
  const { lines } = await captured(async () => {
    const abort = new DOMException("The operation was aborted.", "AbortError");
    logModelErrors()({ error: abort });
  });
  assert.equal(lines.length, 0);
});

test("the SDK's own handler would have printed the raw error", async () => {
  // Pins the reason logModelErrors exists: should the SDK stop printing,
  // this fails and the comment on it can go.
  const { printed } = await captured(async () => {
    const result = streamObject({
      model: refusing(MISMATCH),
      maxRetries: 0,
      schema: DashboardGenerationSchema,
      prompt: "x",
    });
    await textResponseOnceStarted(result).catch(() => {});
  });
  assert.equal(printed.length, 1);
});
