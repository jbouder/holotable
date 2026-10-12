import { config } from "@/lib/config";
import { log } from "@/lib/log";
import type { LogqlPlan } from "@/lib/logql/plan";
import { QueryExecutionError } from "@/lib/sources/execution";
import {
  endpointUrl,
  exchange,
  type HttpSourceTarget,
} from "@/lib/sources/server/endpoint";

/**
 * The Loki HTTP API, as a source is allowed to reach it (#562).
 *
 * Every request goes through `src/lib/sources/server/endpoint.ts`, the
 * exchange the Prometheus client uses too: the guarded fetch under
 * `SOURCE_URL_ALLOWLIST`, checked at DNS time on every connection, no
 * redirect followed, credentials resolved from the `secret_ref` per request
 * (`<REF>_TOKEN`, or `<REF>_USERNAME` / `<REF>_PASSWORD`), the body read under
 * `MAX_RESULT_BYTES` with a deadline on the whole exchange.
 *
 * Every request is a GET. Loki answers POST on `query` and `query_range`, but
 * its label routes say 405 to one (the lesson of #390, where a fake that
 * accepted both hid it), so one method for every route keeps a fake honest.
 *
 * Every parameter that bounds the work (`start`, `end`, `step`, `limit`,
 * `direction`, `time`) comes from the server's plan, never from the spec: a
 * LogQL expression carries no time (`src/lib/logql/safety.ts`).
 */

export type LokiTarget = HttpSourceTarget;

/**
 * The endpoint could not be asked, or did not answer usably: a refused
 * address, a TLS or connection failure, a timeout, a 5xx, a refused
 * credential. Infrastructure, so its message is logged by source id and never
 * shown to the browser (invariant 16).
 */
export class LokiUnavailableError extends Error {
  override name = "LokiUnavailableError";
  constructor(
    message: string,
    /** The HTTP status, when the endpoint answered at all. */
    readonly status?: number,
  ) {
    super(message);
  }
}

const unavailable = (message: string, status?: number) =>
  new LokiUnavailableError(message, status);

/** `<url>/loki/api/v1/<path>`, keeping a path prefix the URL has. */
export function lokiApiUrl(base: string, path: string): string {
  return endpointUrl(base, `/loki/api/v1/${path}`);
}

export interface LokiRequestOptions {
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

const defaults = (): LokiRequestOptions => ({
  timeoutMs: config.queryTimeoutSeconds * 1000,
});

/** Loki's own words on a refused query, one line, bounded. */
function authorMessage(text: string): string {
  let message = text.trim();
  try {
    const body = JSON.parse(message) as { error?: unknown; message?: unknown };
    const said = body.error ?? body.message;
    if (typeof said === "string") message = said;
  } catch {
    // A plain-text body, as Loki answers a query it cannot parse.
  }
  const line = [...message]
    .map((ch) => {
      const code = ch.charCodeAt(0);
      return code < 0x20 || code === 0x7f ? " " : ch;
    })
    .join("")
    .trim();
  return line === "" ? "Loki refused the query" : line.slice(0, 500);
}

/**
 * Ask the endpoint's JSON API under `/loki/api/v1/`, and return the `data` of
 * a success. A 400 is the author's to fix and keeps Loki's message (a query
 * that does not parse, or asks for more than the endpoint allows); anything
 * else that is not a success is the endpoint's, and opaque.
 */
export async function lokiRequest(
  target: LokiTarget,
  path: string,
  params: URLSearchParams,
  opts: LokiRequestOptions = defaults(),
): Promise<unknown> {
  const response = await exchange(
    target,
    lokiApiUrl(target.config.url, path),
    params,
    { ...opts, method: "GET" },
    unavailable,
  );
  if (response.status === 400) {
    throw new QueryExecutionError(authorMessage(response.text));
  }
  let body: { status?: unknown; data?: unknown };
  try {
    body = JSON.parse(response.text) as typeof body;
  } catch {
    throw new LokiUnavailableError(
      `source ${target.id}: ${path} answered ${response.status} with a body that is not JSON`,
      response.status,
    );
  }
  if (response.ok && body.status === "success") return body.data;
  // `status/buildinfo` answers its fields bare, with no envelope.
  if (response.ok && body.status === undefined && path.startsWith("status/")) return body;
  throw new LokiUnavailableError(
    `source ${target.id}: ${path} answered ${response.status}`,
    response.status,
  );
}

/**
 * Ask a path beside the API that answers in plain text (`/ready`): its
 * status, with nothing but whether it was a success kept.
 */
export async function lokiPing(
  target: LokiTarget,
  path: string,
  opts: LokiRequestOptions = defaults(),
): Promise<{ status: number; ok: boolean }> {
  const { status, ok } = await exchange(
    target,
    endpointUrl(target.config.url, path),
    new URLSearchParams(),
    { ...opts, method: "GET" },
    unavailable,
  );
  return { status, ok };
}

/** Nanoseconds since the epoch, as Loki takes a time, exactly. */
export function lokiTime(at: Date): string {
  return `${Math.trunc(at.getTime())}000000`;
}

/**
 * The parameters a plan sends, all of them the server's: what the tests
 * read, and what {@link runLogqlPlan} asks.
 */
export function planParams(plan: LogqlPlan): { path: string; params: URLSearchParams } {
  const params = new URLSearchParams({ query: plan.expr });
  if (plan.instant) {
    params.set("time", lokiTime(plan.time));
    return { path: "query", params };
  }
  params.set("start", lokiTime(plan.start));
  params.set("end", lokiTime(plan.end));
  if (plan.kind === "log") {
    params.set("limit", String(plan.limit));
    params.set("direction", plan.direction);
  } else {
    params.set("step", `${plan.stepSeconds}s`);
  }
  return { path: "query_range", params };
}

/** Run a LogQL plan and return the raw `data` of the answer. */
export function runLogqlPlan(
  target: LokiTarget,
  plan: LogqlPlan,
  fetchImpl?: typeof fetch,
): Promise<unknown> {
  const { path, params } = planParams(plan);
  return lokiRequest(target, path, params, { timeoutMs: plan.timeoutMs, fetchImpl });
}

/**
 * An infrastructure failure, logged by source id. The source's URL and host
 * are taken out of the message, so a log line names the source, never where
 * it lives.
 */
export function logUnavailable(target: LokiTarget, err: unknown): void {
  log.warn("loki.unavailable", {
    sourceId: target.id,
    error: withoutAddress(target.config.url, err),
  });
}

/** An error's message with the source's URL, host and hostname replaced. */
export function withoutAddress(url: string, err: unknown): string {
  let message = err instanceof Error ? err.message : String(err);
  const parts: string[] = [url];
  try {
    const parsed = new URL(url);
    parts.push(parsed.href, parsed.host, parsed.hostname);
  } catch {
    // An unparseable URL never got this far; the raw string is still removed.
  }
  for (const part of parts.filter((p) => p !== "").sort((a, b) => b.length - a.length)) {
    message = message.split(part).join("<source url>");
  }
  return message;
}
