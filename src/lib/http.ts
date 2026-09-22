import type { z } from "zod";
import { HttpError, errorResponse } from "@/lib/auth/authorize";
import { log, newRequestContext, runWithRequest } from "@/lib/log";

/** Parse and validate a JSON request body against a Zod schema, or throw 400. */
export async function readJson<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(
      400,
      `invalid request: ${parsed.error.issues[0]?.message ?? "validation failed"}`,
    );
  }
  return parsed.data;
}

export function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

/** The header a caller quotes back when reporting an error. */
export const REQUEST_ID_HEADER = "x-request-id";

export interface RouteOptions {
  /**
   * Log the completion at `debug` rather than `info`. For the probes —
   * `/api/health`, `/api/ready`, `/api/metrics` — which a kubelet and a
   * scraper hit every few seconds and which would otherwise be the whole log.
   */
  quiet?: boolean;
}

/**
 * Wrap an API route handler.
 *
 * Three things happen here so that no handler has to do them.
 *
 * - A request context is entered ({@link runWithRequest}), so every log line
 *   written anywhere beneath this handler carries the request id, the route,
 *   and — once `requireIdentity`/`assertAuthorized` have run — the subject and
 *   the workspace. Nothing threads a logger.
 * - The outcome is logged once, with the status and how long it took.
 * - The response carries `x-request-id`, so a user reporting "it failed" can
 *   quote an id that appears verbatim in the log.
 *
 * `name` is a fixed, hand-written route label, never the concrete path: a path
 * carries dashboard and source ids, and an id has no business being a
 * dimension you group logs by (the same rule `src/lib/metrics.ts` follows).
 *
 * The catch is a backstop that produces the same response the handlers used to
 * produce by hand, which is why they no longer carry `try`/`catch` of their
 * own; a handler that needs to treat a specific failure differently (the query
 * route and `QueryExecutionError`) still catches it itself.
 *
 * For a streaming response — SSE, or a model stream — the handler returns as
 * soon as the stream is opened, so `durationMs` is the time to the first byte
 * and the context does not extend to frames produced later.
 */
export function route<A extends unknown[]>(
  name: string,
  handler: (req: Request, ...args: A) => Response | Promise<Response>,
  opts: RouteOptions = {},
): (req: Request, ...args: A) => Promise<Response> {
  return async (req, ...args) => {
    const ctx = newRequestContext(req, name);
    return runWithRequest(ctx, async () => {
      const startedAt = Date.now();
      let response: Response;
      try {
        response = await handler(req, ...args);
      } catch (err) {
        response = errorResponse(err);
      }

      const durationMs = Date.now() - startedAt;
      const fields = { method: ctx.method, status: response.status, durationMs };
      if (response.status >= 500) log.error("request.failed", fields);
      else if (response.status >= 400) log.warn("request.rejected", fields);
      else if (opts.quiet) log.debug("request.completed", fields);
      else log.info("request.completed", fields);

      return stampRequestId(response, ctx.requestId);
    });
  };
}

/**
 * Attach the request id. `Response.redirect()` returns a response whose header
 * guard is immutable, so a bodyless response that refuses the header is rebuilt
 * rather than silently going out without one.
 */
function stampRequestId(response: Response, requestId: string): Response {
  try {
    response.headers.set(REQUEST_ID_HEADER, requestId);
    return response;
  } catch {
    if (response.body !== null) return response;
    const headers = new Headers(response.headers);
    headers.set(REQUEST_ID_HEADER, requestId);
    return new Response(null, { status: response.status, headers });
  }
}
