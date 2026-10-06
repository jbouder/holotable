import { APICallError, type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import { log } from "@/lib/log";

/**
 * Resilient model invocation (#22): one deadline and a bounded, jittered retry
 * around every request the app makes to a provider.
 *
 * It is a model middleware rather than a wrapper around `streamObject` and
 * `streamText`, so it sits under every call site at once: the generation paths
 * in `generate.ts`, the dashboard chat, and whatever is added next. Each call
 * site turns the SDK's own retry off (`maxRetries: 0`, through
 * `modelSettings()` in `provider.ts`); otherwise the two loops multiply, and
 * the SDK would hand back a `RetryError` instead of the provider's error.
 *
 * What is retried: a failure the provider classifies as transient
 * (`isRetryable`, which the SDK sets for 408, 409, 429, 5xx and a network
 * failure), before any output has arrived. A 401, 404 or a schema the model
 * does not support fails at once. A stream that breaks after it started is not
 * retried: its partial output has already gone to the browser, and a second
 * attempt would be a second, different answer.
 *
 * The deadline covers the whole request, retries and waits included, so a
 * hung provider ends at `AI_REQUEST_TIMEOUT_MS` instead of at the route's
 * `maxDuration`, where the platform would cut the response with no error at
 * all. It is enforced here, not left to the provider's fetch, so a provider
 * that ignores the abort signal still stops.
 */

export interface ResilienceOptions {
  /** The deadline for one model request, retries and waits included. */
  timeoutMs: number;
  /** Retries after the first attempt. `0` disables retrying. */
  maxRetries: number;
  /** Waits `ms`, rejecting when `signal` aborts. Replaced in tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** A number in [0, 1), for the jitter. Replaced in tests. */
  random?: () => number;
}

/** The first backoff ceiling; each retry doubles it, up to {@link MAX_BACKOFF_MS}. */
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;

/** A model request that ran past its deadline. */
export class ModelTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`The model did not finish within ${timeoutMs}ms.`);
    this.name = "ModelTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** Wrap `model` so every request it serves gets the deadline and the retry. */
export function resilientModel(
  model: Parameters<typeof wrapLanguageModel>[0]["model"],
  options: ResilienceOptions,
) {
  return wrapLanguageModel({ model, middleware: resilience(options) });
}

export function resilience(options: ResilienceOptions): LanguageModelMiddleware {
  return {
    specificationVersion: "v4",
    wrapGenerate: async ({ params, model }) => {
      const deadline = startDeadline(params.abortSignal, options.timeoutMs);
      try {
        return await withRetry(
          () => model.doGenerate({ ...params, abortSignal: deadline.signal }),
          deadline.signal,
          options,
        );
      } catch (error) {
        throw deadline.explain(error);
      } finally {
        deadline.clear();
      }
    },
    wrapStream: async ({ params, model }) => {
      const deadline = startDeadline(params.abortSignal, options.timeoutMs);
      try {
        const result = await withRetry(
          () => model.doStream({ ...params, abortSignal: deadline.signal }),
          deadline.signal,
          options,
        );
        // The deadline outlives this call: it runs until the stream ends.
        return { ...result, stream: untilDeadline(result.stream, deadline) };
      } catch (error) {
        deadline.clear();
        throw deadline.explain(error);
      }
    },
  };
}

interface Deadline {
  /** Aborts at the deadline or when the caller's signal does. */
  signal: AbortSignal;
  /** True once the deadline itself has fired. */
  readonly expired: boolean;
  /** Stop the timer. Idempotent. */
  clear(): void;
  /** `error`, or a {@link ModelTimeoutError} when the deadline caused it. */
  explain(error: unknown): unknown;
  /** Run `fn` when the deadline fires. */
  onExpire(fn: () => void): void;
}

/**
 * A timer of our own rather than `AbortSignal.timeout`, whose timer does not
 * hold the event loop open, and an explicit `clear` so a finished request
 * does not leave one armed.
 */
function startDeadline(caller: AbortSignal | undefined, timeoutMs: number): Deadline {
  const controller = new AbortController();
  const listeners: Array<() => void> = [];
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    log.warn("model request timed out", { timeoutMs });
    controller.abort(new ModelTimeoutError(timeoutMs));
    for (const fn of listeners) fn();
  }, timeoutMs);
  return {
    signal: caller ? AbortSignal.any([caller, controller.signal]) : controller.signal,
    get expired() {
      return expired;
    },
    clear: () => clearTimeout(timer),
    explain: (error) =>
      expired && !caller?.aborted ? new ModelTimeoutError(timeoutMs) : error,
    onExpire: (fn) => {
      listeners.push(fn);
    },
  };
}

/**
 * Pass `source` through, erroring it with a {@link ModelTimeoutError} if the
 * deadline arrives before it ends, and stopping the deadline when it does end.
 */
function untilDeadline<T>(
  source: ReadableStream<T>,
  deadline: Deadline,
): ReadableStream<T> {
  const reader = source.getReader();
  return new ReadableStream<T>({
    start(controller) {
      deadline.onExpire(() => {
        controller.error(deadline.explain(undefined));
        reader.cancel().catch(() => {});
      });
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          deadline.clear();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        deadline.clear();
        // The deadline already errored the stream with the clearer error.
        if (!deadline.expired) controller.error(error);
      }
    },
    cancel(reason) {
      deadline.clear();
      return reader.cancel(reason);
    },
  });
}

/**
 * Call `attempt`, retrying a transient failure with jittered exponential
 * backoff. Gives up early, with the provider's error, when the next wait would
 * not end before the deadline. The error that surfaces is the provider's own,
 * never a wrapper.
 */
export async function withRetry<T>(
  attempt: () => PromiseLike<T>,
  signal: AbortSignal,
  options: ResilienceOptions,
): Promise<T> {
  const sleep = options.sleep ?? abortableSleep;
  const random = options.random ?? Math.random;
  const deadline = Date.now() + options.timeoutMs;
  for (let retry = 0; ; retry++) {
    try {
      return await attempt();
    } catch (error) {
      if (signal.aborted || retry >= options.maxRetries || !isRetryable(error))
        throw error;
      const delayMs = retryAfterMs(error) ?? backoffMs(retry, random);
      if (Date.now() + delayMs >= deadline) throw error;
      log.warn("model request failed; retrying", {
        attempt: retry + 1,
        maxRetries: options.maxRetries,
        delayMs,
        status: APICallError.isInstance(error) ? error.statusCode : undefined,
      });
      await sleep(delayMs, signal);
    }
  }
}

/** Full jitter: anywhere in [0, ceiling), the ceiling doubling per retry. */
export function backoffMs(retry: number, random: () => number): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** retry);
  return Math.floor(random() * ceiling);
}

/**
 * Transient by the provider's own account. `APICallError` and the gateway's
 * error both carry `isRetryable`; anything without it (a schema the model
 * cannot honor, a missing key) is permanent.
 */
export function isRetryable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "isRetryable" in error &&
    error.isRetryable === true
  );
}

/** The wait a 429 or 503 asked for, from `retry-after-ms` or `retry-after`. */
export function retryAfterMs(
  error: unknown,
  now: number = Date.now(),
): number | undefined {
  if (!APICallError.isInstance(error) || !error.responseHeaders) return undefined;
  const headers = error.responseHeaders;
  const ms = Number.parseFloat(headers["retry-after-ms"] ?? "");
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const value = headers["retry-after"];
  if (!value) return undefined;
  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
