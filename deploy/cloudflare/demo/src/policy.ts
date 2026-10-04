/**
 * The demo Worker's decisions, as pure functions over a Request, so they can
 * be tested with plain Node and no Workers runtime (test/policy.test.ts).
 */

/** Which per-IP limit a request counts against. */
export type Bucket = "write" | "read";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * `write` is any non-GET call to the app's API: generation, queries, edits,
 * chat, sign-in and sign-out. Those cost CPU, database time or model tokens.
 * Everything else (pages, static assets, the live SSE stream, reads) is
 * `read`, which only has to stop a flood.
 */
export function bucketFor(request: Request): Bucket {
  const { pathname } = new URL(request.url);
  if (!SAFE_METHODS.has(request.method) && pathname.startsWith("/api/")) return "write";
  return "read";
}

/**
 * Who a limit is keyed on. `CF-Connecting-IP` is set by Cloudflare's edge on
 * every request to a Worker and cannot be supplied by the client, unlike
 * `X-Forwarded-For`.
 */
export function clientKey(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

/** A browser navigation, as opposed to fetch, XHR, SSE or an asset. */
export function wantsDocument(request: Request): boolean {
  if (request.method !== "GET") return false;
  const dest = request.headers.get("sec-fetch-dest");
  if (dest) return dest === "document";
  return (request.headers.get("accept") ?? "").includes("text/html");
}

/**
 * The request as the container should see it. The containers library proxies
 * over plain HTTP to the instance, so the app would otherwise build its demo
 * sign-in redirect for `http://`; it reads the visitor's real scheme and host
 * from these headers (src/proxy.ts). Client-sent copies are overwritten.
 */
export function forContainer(request: Request): Request {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.set("x-forwarded-proto", url.protocol.replace(/:$/, ""));
  headers.set("x-forwarded-host", url.host);
  const ip = request.headers.get("cf-connecting-ip");
  if (ip) headers.set("x-forwarded-for", ip);
  else headers.delete("x-forwarded-for");
  return new Request(request, { headers });
}

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} as const;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${title}</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 16px/1.5 system-ui, sans-serif; background: #0b0f14; color: #d8dee9; }
  main { max-width: 32rem; padding: 2rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: .5rem 0; color: #9aa5b1; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

/**
 * What a visitor sees while the container boots: a fresh database, migrations
 * and six hours of backfilled history. It refreshes itself; once the container
 * answers, the same URL serves the app.
 */
export function startingResponse(request: Request, seconds: number): Response {
  const retry = "3";
  if (!wantsDocument(request)) {
    return Response.json(
      { error: "The demo is starting. Try again in a few seconds.", kind: "unavailable" },
      { status: 503, headers: { "retry-after": retry, "cache-control": "no-store" } },
    );
  }
  return new Response(
    page(
      "Starting the Holotable demo",
      `<h1>Starting the demo</h1>
<p>Holotable is waking up: a fresh database, migrations and six hours of demo history. This takes about ${seconds} seconds.</p>
<p>This page refreshes on its own.</p>`,
    ),
    { status: 503, headers: { ...PAGE_HEADERS, refresh: retry, "retry-after": retry } },
  );
}

/** What a client over its per-IP limit gets. */
export function limitedResponse(request: Request, bucket: Bucket): Response {
  const retry = bucket === "write" ? "60" : "10";
  if (!wantsDocument(request)) {
    return Response.json(
      {
        error:
          "Too many requests from your address to the demo. Wait a minute and try again.",
        kind: "rate_limited",
      },
      { status: 429, headers: { "retry-after": retry, "cache-control": "no-store" } },
    );
  }
  return new Response(
    page(
      "Slow down",
      `<h1>Too many requests</h1>
<p>Your address has sent more requests than the public demo allows. Wait a minute and reload.</p>`,
    ),
    { status: 429, headers: { ...PAGE_HEADERS, "retry-after": retry } },
  );
}

/**
 * The demo's model limits, tighter than the app's defaults because every
 * visitor shares one workspace and a fresh session resets the per-person
 * bucket. Strings, because container environment variables are strings.
 */
export function demoLimits(vars: {
  LLM_RATE_PER_MINUTE?: string;
  LLM_DAILY_TOKEN_BUDGET?: string;
}): { LLM_RATE_PER_MINUTE: string; LLM_DAILY_TOKEN_BUDGET: string } {
  const positive = (v: string | undefined, fallback: string) =>
    v && /^[1-9]\d*$/.test(v) ? v : fallback;
  return {
    LLM_RATE_PER_MINUTE: positive(vars.LLM_RATE_PER_MINUTE, "5"),
    LLM_DAILY_TOKEN_BUDGET: positive(vars.LLM_DAILY_TOKEN_BUDGET, "300000"),
  };
}
