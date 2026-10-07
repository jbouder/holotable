import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { APICallError, type LanguageModel, streamText } from "ai";
import {
  backoffMs,
  isRetryable,
  ModelTimeoutError,
  type ResilienceOptions,
  resilientModel,
  retryAfterMs,
  withRetry,
} from "@/lib/ai/invoke";
import { stubModel } from "@/lib/ai/stub";

/*
 * Model timeouts and backoff (#22). The retry and the deadline live in a model
 * middleware, so these drive it with a stubbed provider: through `withRetry`
 * for the policy, and through `streamText` for what a route actually sees.
 */

type V4 = Extract<LanguageModel, { specificationVersion: "v4" }>;
type StreamResult = Awaited<ReturnType<V4["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

function apiError(statusCode: number, headers?: Record<string, string>): APICallError {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: "https://provider.test/v1/responses",
    requestBodyValues: {},
    statusCode,
    responseHeaders: headers,
  });
}

/** Records every wait instead of taking it. */
function fakeSleep() {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

function options(overrides: Partial<ResilienceOptions> = {}): ResilienceOptions {
  return { timeoutMs: 10_000, maxRetries: 2, random: () => 0.5, ...overrides };
}

/** An attempt that fails with each of `errors` in turn, then succeeds. */
function failing(errors: unknown[]) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    attempt: async () => {
      const error = errors[calls++];
      if (error) throw error;
      return "ok";
    },
  };
}

const live = () => new AbortController().signal;

test("a 429 or 5xx is retried with jittered backoff, then succeeds", async () => {
  const { waits, sleep } = fakeSleep();
  const run = failing([apiError(429), apiError(503)]);
  const result = await withRetry(run.attempt, live(), options({ sleep }));
  assert.equal(result, "ok");
  assert.equal(run.calls, 3);
  // Half of a 500ms ceiling, then half of 1000ms: the ceiling doubles.
  assert.deepEqual(waits, [250, 500]);
});

test("after the last retry the provider's own error surfaces unchanged", async () => {
  const { sleep } = fakeSleep();
  const last = apiError(502);
  const run = failing([apiError(500), apiError(503), last]);
  await assert.rejects(
    withRetry(run.attempt, live(), options({ sleep })),
    (error) => error === last,
  );
  assert.equal(run.calls, 3);
});

test("a 401 or 404 is not retried", async () => {
  for (const status of [400, 401, 403, 404]) {
    const { waits, sleep } = fakeSleep();
    const run = failing([apiError(status)]);
    await assert.rejects(withRetry(run.attempt, live(), options({ sleep })));
    assert.equal(run.calls, 1, `HTTP ${status} was retried`);
    assert.deepEqual(waits, []);
  }
});

test("an error without isRetryable is permanent", async () => {
  const run = failing([new Error("schema not supported")]);
  await assert.rejects(
    withRetry(run.attempt, live(), options({ sleep: async () => {} })),
  );
  assert.equal(run.calls, 1);
});

test("a successful first attempt makes exactly one call", async () => {
  const run = failing([]);
  assert.equal(await withRetry(run.attempt, live(), options()), "ok");
  assert.equal(run.calls, 1);
});

test("AI_MAX_RETRIES=0 disables retrying", async () => {
  const run = failing([apiError(503)]);
  await assert.rejects(withRetry(run.attempt, live(), options({ maxRetries: 0 })));
  assert.equal(run.calls, 1);
});

test("retry-after from the provider beats the computed backoff", async () => {
  const { waits, sleep } = fakeSleep();
  const run = failing([
    apiError(429, { "retry-after": "2" }),
    apiError(429, { "retry-after-ms": "750" }),
  ]);
  await withRetry(run.attempt, live(), options({ sleep }));
  assert.deepEqual(waits, [2000, 750]);
});

test("a wait that would end past the deadline gives up with the provider's error", async () => {
  const { waits, sleep } = fakeSleep();
  const first = apiError(429, { "retry-after": "60" });
  const run = failing([first]);
  await assert.rejects(
    withRetry(run.attempt, live(), options({ sleep, timeoutMs: 5_000 })),
    (error) => error === first,
  );
  assert.equal(run.calls, 1);
  assert.deepEqual(waits, []);
});

test("backoff is full jitter under a doubling, capped ceiling", () => {
  assert.equal(
    backoffMs(0, () => 0),
    0,
  );
  assert.equal(
    backoffMs(0, () => 0.999),
    499,
  );
  assert.equal(
    backoffMs(3, () => 0.5),
    2000,
  );
  assert.equal(
    backoffMs(10, () => 0.5),
    4000,
  );
});

test("retryAfterMs reads seconds, milliseconds and an HTTP date", () => {
  assert.equal(retryAfterMs(apiError(429, { "retry-after": "1.5" })), 1500);
  assert.equal(retryAfterMs(apiError(429, { "retry-after-ms": "20" })), 20);
  const now = Date.parse("2026-10-06T12:00:00Z");
  assert.equal(
    retryAfterMs(apiError(503, { "retry-after": "Tue, 06 Oct 2026 12:00:03 GMT" }), now),
    3000,
  );
  assert.equal(retryAfterMs(apiError(429)), undefined);
  assert.equal(retryAfterMs(new Error("nope")), undefined);
});

test("isRetryable follows the provider's classification", () => {
  assert.equal(isRetryable(apiError(429)), true);
  assert.equal(isRetryable(apiError(500)), true);
  assert.equal(isRetryable(apiError(401)), false);
  assert.equal(isRetryable(apiError(404)), false);
  assert.equal(isRetryable(new Error("x")), false);
  assert.equal(isRetryable({ isRetryable: true }), true);
});

// --- Through the SDK, as a route sees it -----------------------------------

/** A v4 model whose doStream is `impl`, counting calls. */
function fakeModel(impl: (call: number, signal?: AbortSignal) => Promise<StreamResult>) {
  let calls = 0;
  const model: V4 = {
    specificationVersion: "v4",
    provider: "fake",
    modelId: "fake",
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error("not used")),
    doStream: (options) => impl(calls++, options.abortSignal),
  };
  return {
    model,
    get calls() {
      return calls;
    },
  };
}

/** Never resolves, except by rejecting when `signal` aborts. */
function hang(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/**
 * Read a streamText result to the end; resolves with the error it reported,
 * through `onError` or by rejecting the read, whichever it chose.
 */
async function drain(result: ReturnType<typeof streamText>, errors: unknown[]) {
  try {
    for await (const _ of result.textStream) {
      // drain
    }
  } catch (error) {
    return error;
  }
  return errors[0];
}

test("a hung provider aborts at the deadline with ModelTimeoutError", async () => {
  const fake = fakeModel((_, signal) => hang(signal));
  const errors: unknown[] = [];
  const started = Date.now();
  const result = streamText({
    model: resilientModel(fake.model, { timeoutMs: 50, maxRetries: 2 }),
    maxRetries: 0,
    prompt: "hello",
    onError: ({ error }) => {
      errors.push(error);
    },
  });
  const error = await drain(result, errors);
  assert.ok(error instanceof ModelTimeoutError, `got ${String(error)}`);
  assert.equal(fake.calls, 1);
  assert.ok(Date.now() - started < 2_000, "the deadline did not fire");
});

test("a stream that stalls after starting is cut off at the deadline", async () => {
  const fake = fakeModel(async () => ({
    // One chunk, then nothing: a provider that ignores the abort signal.
    stream: new ReadableStream<StreamPart>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "text-start", id: "t" });
        controller.enqueue({ type: "text-delta", id: "t", delta: "partial" });
      },
    }),
  }));
  const errors: unknown[] = [];
  const result = streamText({
    model: resilientModel(fake.model, { timeoutMs: 50, maxRetries: 2 }),
    maxRetries: 0,
    prompt: "hello",
    onError: ({ error }) => {
      errors.push(error);
    },
  });
  const error = await drain(result, errors);
  assert.ok(error instanceof ModelTimeoutError, `got ${String(error)}`);
  // Output had started, so it is not retried.
  assert.equal(fake.calls, 1);
});

test("through streamText, a 503 is retried and the answer arrives", async () => {
  const stub = stubModel();
  const fake = fakeModel(async (call, signal) => {
    if (call === 0) throw apiError(503, { "retry-after-ms": "1" });
    return stub.doStream({ prompt: [], abortSignal: signal });
  });
  const result = streamText({
    model: resilientModel(fake.model, { timeoutMs: 5_000, maxRetries: 2 }),
    maxRetries: 0,
    prompt: "hello",
  });
  assert.ok((await result.text).length > 0);
  assert.equal(fake.calls, 2);
});

test("the caller's own abort passes through, not as a timeout", async () => {
  const fake = fakeModel((_, signal) => hang(signal));
  const controller = new AbortController();
  const errors: unknown[] = [];
  const result = streamText({
    model: resilientModel(fake.model, { timeoutMs: 5_000, maxRetries: 2 }),
    maxRetries: 0,
    prompt: "hello",
    abortSignal: controller.signal,
    onError: ({ error }) => {
      errors.push(error);
    },
  });
  setTimeout(() => controller.abort(), 10);
  const error = await drain(result, errors);
  assert.ok(!(error instanceof ModelTimeoutError));
  assert.ok(!errors.some((e) => e instanceof ModelTimeoutError));
  assert.equal(fake.calls, 1);
});

// --- Every call site goes through modelSettings() --------------------------

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The text of the object literal that opens at `start` (a `{`), braces balanced. */
function objectAt(text: string, start: number): string {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

/** Whether `object` sets `key` itself, rather than in an object nested in it. */
function setsOwnKey(object: string, key: string): boolean {
  let depth = 0;
  for (let i = 0; i < object.length; i++) {
    if (object[i] === "{") depth++;
    else if (object[i] === "}") depth--;
    else if (
      depth === 1 &&
      object.startsWith(`${key}:`, i) &&
      !/\w/.test(object[i - 1])
    ) {
      return true;
    }
  }
  return false;
}

test("every model call spreads modelSettings(), so the SDK's retry stays off and its errors are logged", () => {
  const offenders: string[] = [];
  let calls = 0;
  for (const file of sources(join(process.cwd(), "src"))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(
      /\b(streamObject|streamText|generateObject|generateText)\(\{/g,
    )) {
      calls++;
      const where = `${file.slice(process.cwd().length + 1)}: ${match[1]}`;
      // The options object opens at the match; modelSettings() must be in it
      // before its first nested object closes the call's first lines.
      const head = text.slice(match.index, match.index + 200);
      if (!head.includes("...modelSettings()")) offenders.push(where);
      // Its own onError would replace the one that logs through the redacting
      // log, and the SDK's raw dump never comes back, but neither does the
      // log line (#343).
      const options = objectAt(text, match.index + match[0].length - 1);
      if (setsOwnKey(options, "onError")) offenders.push(`${where} replaces onError`);
    }
  }
  assert.ok(calls >= 6, `found only ${calls} model calls; has the scan broken?`);
  assert.deepEqual(offenders, []);
});

test("the scan sees an onError the call sets, and not one nested in it", () => {
  const own = "streamText({ ...modelSettings(), onError: () => {} })";
  const nested = "streamText({ ...modelSettings(), tools: { x: { onError: 1 } } })";
  assert.equal(setsOwnKey(objectAt(own, own.indexOf("{")), "onError"), true);
  assert.equal(setsOwnKey(objectAt(nested, nested.indexOf("{")), "onError"), false);
});
