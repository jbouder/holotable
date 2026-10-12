import { config } from "@/lib/config";
import { log } from "@/lib/log";
import type { PromqlPlan } from "@/lib/promql/plan";
import { QueryExecutionError } from "@/lib/sources/execution";
import type { PrometheusConfig } from "@/lib/sources/kinds/prometheus";
import { endpointUrl, exchange as endpointExchange } from "@/lib/sources/server/endpoint";

export { sourceUrlAllowlist } from "@/lib/sources/server/endpoint";

/**
 * The Prometheus HTTP API, as a source is allowed to reach it (#385).
 *
 * Every request goes through `src/lib/sources/server/endpoint.ts`, the one
 * exchange every HTTP kind shares: the guarded fetch under
 * `SOURCE_URL_ALLOWLIST`, checked at DNS time on every connection, no
 * redirect followed, credentials resolved from the `secret_ref` on every
 * request, the body read under the byte cap and a deadline on the whole
 * exchange. Nothing but the JSON body is kept.
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
  constructor(
    message: string,
    /** The HTTP status, when the endpoint answered at all. */
    readonly status?: number,
  ) {
    super(message);
  }
}

/** `<url>/api/v1/<path>`, keeping a path prefix the URL has. */
export function apiUrl(base: string, path: string): string {
  return endpointUrl(base, `/api/v1/${path}`);
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

interface RequestOptions {
  timeoutMs: number;
  /**
   * POST (the default) sends `form` as the body, which every
   * Prometheus-compatible API accepts for `query`, `query_range`, `series`
   * and `labels`, and which keeps an 8,000-character expression out of a URL.
   * GET puts it in the query string, for the endpoints that only answer GET
   * (`metadata`, `status/*`).
   */
  method?: "GET" | "POST";
  fetchImpl?: typeof fetch;
}

/**
 * One exchange with the endpoint: the request through the guarded fetch with
 * the source's credentials, and the body read under the byte cap. `path` is
 * under `/api/v1/`, or, starting with `/`, under the source URL itself
 * (`/-/ready`).
 */
function exchange(
  target: PrometheusTarget,
  path: string,
  form: URLSearchParams,
  opts: RequestOptions,
): Promise<{ status: number; ok: boolean; text: string }> {
  const url = path.startsWith("/")
    ? endpointUrl(target.config.url, path)
    : apiUrl(target.config.url, path);
  return endpointExchange(
    target,
    url,
    form,
    { ...opts, method: opts.method ?? "POST" },
    (message, status) => new PrometheusUnavailableError(message, status),
  );
}

/**
 * Ask a path the endpoint answers in plain text (`/-/ready`): its status,
 * with nothing but whether it was a success kept.
 */
export async function prometheusPing(
  target: PrometheusTarget,
  path: string,
  opts: RequestOptions,
): Promise<{ status: number; ok: boolean }> {
  const { status, ok } = await exchange(target, path, new URLSearchParams(), {
    ...opts,
    method: "GET",
  });
  return { status, ok };
}

/** Ask the endpoint's JSON API, and return the `data` of a success. */
export async function prometheusRequest(
  target: PrometheusTarget,
  path: string,
  form: URLSearchParams,
  opts: RequestOptions = { timeoutMs: config.queryTimeoutSeconds * 1000 },
): Promise<unknown> {
  const response = await exchange(target, path, form, opts);
  let body: ApiEnvelope;
  try {
    body = JSON.parse(response.text) as ApiEnvelope;
  } catch {
    throw new PrometheusUnavailableError(
      `source ${target.id}: ${path} answered ${response.status} with a body that is not JSON`,
      response.status,
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
    response.status,
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
