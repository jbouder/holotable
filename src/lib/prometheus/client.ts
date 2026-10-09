import { parseBaseUrlAllowlist, type BaseUrlAllowlist } from "@/lib/ai/base-url";
import { BaseUrlRefusedError, guardedFetch } from "@/lib/ai/guarded-fetch";
import { config } from "@/lib/config";
import { log } from "@/lib/log";
import type { PromqlPlan } from "@/lib/promql/plan";
import { resolveBearerToken, resolveCredentials } from "@/lib/secrets/credentials";
import { QueryExecutionError } from "@/lib/sources/execution";
import type { PrometheusConfig } from "@/lib/sources/kinds/prometheus";

/**
 * The Prometheus HTTP API, as a source is allowed to reach it (#385).
 *
 * Every request goes through the guarded fetch (`src/lib/ai/guarded-fetch.ts`)
 * under `SOURCE_URL_ALLOWLIST`: https only unless allowlisted, no private
 * address unless allowlisted, checked at DNS time on every connection, no
 * redirect followed. Credentials are resolved from the `secret_ref` on every
 * request, under the workspace grant. The response is read with a byte cap as
 * it arrives and a deadline on the whole exchange, and nothing but its JSON
 * body is kept: no response header ever leaves this module.
 */

/** Who is asking, as much of a source as a request needs. */
export interface PrometheusTarget {
  id: string;
  workspaceId: string;
  secretRef: string | null;
  config: Pick<PrometheusConfig, "url" | "auth">;
}

/**
 * The endpoint could not be asked, or did not answer usably: a refused
 * address, a TLS or connection failure, a timeout, a 5xx. Infrastructure, so
 * its message is logged and never shown to the browser (invariant 16).
 */
export class PrometheusUnavailableError extends Error {
  override name = "PrometheusUnavailableError";
}

let allowlistCache: { raw: string; allowlist: BaseUrlAllowlist } | null = null;

/** `SOURCE_URL_ALLOWLIST`, parsed once per value. */
export function sourceUrlAllowlist(): BaseUrlAllowlist {
  const raw = config.sourceUrlAllowlist;
  if (allowlistCache?.raw !== raw) {
    allowlistCache = {
      raw,
      allowlist: parseBaseUrlAllowlist(raw, {
        variable: "SOURCE_URL_ALLOWLIST",
        noun: "source URL",
      }),
    };
  }
  return allowlistCache.allowlist;
}

/** The `Authorization` header for a source's auth mode, resolved now. */
function authorization(target: PrometheusTarget): Record<string, string> {
  const { auth } = target.config;
  if (auth === "none") return {};
  if (!target.secretRef) {
    throw new PrometheusUnavailableError(
      `source ${target.id} has auth "${auth}" but no secret_ref`,
    );
  }
  if (auth === "bearer") {
    return {
      Authorization: `Bearer ${resolveBearerToken(target.secretRef, target.workspaceId)}`,
    };
  }
  const { username, password } = resolveCredentials(target.secretRef, target.workspaceId);
  return {
    Authorization: `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`,
  };
}

/** `<url>/api/v1/<path>`, keeping a path prefix the URL has. */
export function apiUrl(base: string, path: string): string {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/v1/${path}`;
  return url.href;
}

/** Read a body, stopping as soon as it passes `maxBytes`. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new QueryExecutionError(
        `the result is larger than ${formatBytes(maxBytes)}; narrow the query with a matcher or an aggregation, or shorten the window`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MiB`;
  if (bytes >= 1024) return `${Math.round((bytes / 1024) * 10) / 10} KiB`;
  return `${bytes} B`;
}

interface ApiEnvelope {
  status?: string;
  data?: unknown;
  errorType?: string;
  error?: string;
}

/**
 * The error types Prometheus gives a query that is the author's to fix: one
 * that does not parse (`bad_data`) or cannot be evaluated as written
 * (`execution`, e.g. too many samples).
 */
const AUTHOR_ERRORS = new Set(["bad_data", "execution"]);

/**
 * Ask the endpoint. `form` is sent as a POST body, which every
 * Prometheus-compatible API accepts for `query`, `query_range` and the label
 * endpoints, and which keeps an 8,000-character expression out of a URL.
 */
export async function prometheusRequest(
  target: PrometheusTarget,
  path: string,
  form: URLSearchParams,
  opts: { timeoutMs: number; fetchImpl?: typeof fetch } = {
    timeoutMs: config.queryTimeoutSeconds * 1000,
  },
): Promise<unknown> {
  const url = apiUrl(target.config.url, path);
  const fetcher = opts.fetchImpl ?? guardedFetch(target.config.url, sourceUrlAllowlist());
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        ...authorization(target),
      },
      body: form.toString(),
      signal: AbortSignal.timeout(opts.timeoutMs + 1_000),
    });
  } catch (err) {
    if (err instanceof QueryExecutionError) throw err;
    const reason =
      err instanceof BaseUrlRefusedError
        ? err.message
        : err instanceof Error && err.name === "TimeoutError"
          ? `no answer within ${opts.timeoutMs + 1_000}ms`
          : err instanceof Error
            ? err.message
            : String(err);
    throw new PrometheusUnavailableError(`source ${target.id}: ${reason}`);
  }

  const text = await readCapped(response, config.maxResultBytes);
  let body: ApiEnvelope;
  try {
    body = JSON.parse(text) as ApiEnvelope;
  } catch {
    throw new PrometheusUnavailableError(
      `source ${target.id}: ${path} answered ${response.status} with a body that is not JSON`,
    );
  }
  if (response.ok && body.status === "success") return body.data;
  if (
    (response.status === 400 || response.status === 422) &&
    body.errorType !== undefined &&
    AUTHOR_ERRORS.has(body.errorType)
  ) {
    throw new QueryExecutionError(body.error ?? "Prometheus refused the query");
  }
  throw new PrometheusUnavailableError(
    `source ${target.id}: ${path} answered ${response.status}${body.errorType ? ` (${body.errorType})` : ""}${body.error ? `: ${body.error}` : ""}`,
  );
}

/** Seconds since the epoch, as the API takes a time. */
function apiTime(at: Date): string {
  return (at.getTime() / 1000).toFixed(3);
}

/** Run a PromQL plan and return the raw `data` of the answer. */
export function runPromqlPlan(
  target: PrometheusTarget,
  plan: PromqlPlan,
  fetchImpl?: typeof fetch,
): Promise<unknown> {
  const timeout = `${Math.max(1, Math.round(plan.timeoutMs / 1000))}s`;
  const form = new URLSearchParams({ query: plan.expr, timeout });
  if (plan.instant) {
    form.set("time", apiTime(plan.time));
    return prometheusRequest(target, "query", form, {
      timeoutMs: plan.timeoutMs,
      fetchImpl,
    });
  }
  form.set("start", apiTime(plan.start));
  form.set("end", apiTime(plan.end));
  form.set("step", `${plan.stepSeconds}s`);
  return prometheusRequest(target, "query_range", form, {
    timeoutMs: plan.timeoutMs,
    fetchImpl,
  });
}

/** Log an infrastructure failure the way the SQL executor does, by source id. */
export function logUnavailable(target: PrometheusTarget, err: unknown): void {
  log.warn("prometheus.unavailable", {
    sourceId: target.id,
    error: err instanceof Error ? err.message : String(err),
  });
}
