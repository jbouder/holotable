import { parseBaseUrlAllowlist, type BaseUrlAllowlist } from "@/lib/ai/base-url";
import { BaseUrlRefusedError, guardedFetch } from "@/lib/ai/guarded-fetch";
import { config } from "@/lib/config";
import { resolveBearerToken, resolveCredentials } from "@/lib/secrets/credentials";
import { QueryExecutionError } from "@/lib/sources/execution";
import type { HttpSourceAuth } from "@/lib/sources/http-config";

/**
 * One exchange with a source's HTTP endpoint, for every kind reached over
 * HTTP (Prometheus #385, Loki #562): the only way either client reaches the
 * network.
 *
 * Every request goes through the guarded fetch (`src/lib/ai/guarded-fetch.ts`)
 * under `SOURCE_URL_ALLOWLIST`: https only unless allowlisted, no private
 * address unless allowlisted, checked at DNS time on every connection, no
 * redirect followed. Credentials are resolved from the `secret_ref` on every
 * request, under the workspace grant. The response is read with a byte cap as
 * it arrives and a deadline on the whole exchange, and nothing but its body
 * is kept: no response header ever leaves this module.
 */

/** Who is asking, as much of a source as a request needs. */
export interface HttpSourceTarget {
  id: string;
  workspaceId: string;
  secretRef: string | null;
  config: { url: string; auth: HttpSourceAuth };
}

/**
 * Builds the kind's own infrastructure error, which its server half logs by
 * source id and which reaches the browser only as the opaque message.
 */
export type Unavailable = (message: string, status?: number) => Error;

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
function authorization(
  target: HttpSourceTarget,
  unavailable: Unavailable,
): Record<string, string> {
  const { auth } = target.config;
  if (auth === "none") return {};
  if (!target.secretRef) {
    throw unavailable(`source ${target.id} has auth "${auth}" but no secret_ref`);
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

/** `<url><path>`, keeping a path prefix the URL has. */
export function endpointUrl(base: string, path: string): string {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
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

export interface ExchangeOptions {
  timeoutMs: number;
  /**
   * POST sends `form` as the body; GET (the default) puts it in the query
   * string.
   */
  method?: "GET" | "POST";
  fetchImpl?: typeof fetch;
}

/**
 * One request to `url` (under the source's URL) through the guarded fetch
 * with the source's credentials, and the body read under the byte cap.
 */
export async function exchange(
  target: HttpSourceTarget,
  url: string,
  form: URLSearchParams,
  opts: ExchangeOptions,
  unavailable: Unavailable,
): Promise<{ status: number; ok: boolean; text: string }> {
  const method = opts.method ?? "GET";
  const href =
    method === "GET" && [...form.keys()].length > 0 ? `${url}?${form.toString()}` : url;
  const fetcher = opts.fetchImpl ?? guardedFetch(target.config.url, sourceUrlAllowlist());
  let response: Response;
  try {
    response = await fetcher(href, {
      method,
      headers: {
        Accept: "application/json",
        ...(method === "POST"
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : {}),
        ...authorization(target, unavailable),
      },
      ...(method === "POST" ? { body: form.toString() } : {}),
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
    throw unavailable(`source ${target.id}: ${reason}`);
  }
  const text = await readCapped(response, config.maxResultBytes);
  return { status: response.status, ok: response.ok, text };
}
