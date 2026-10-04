import { type NextRequest, NextResponse } from "next/server";
import { config as appConfig } from "@/lib/config";
import {
  contentSecurityPolicy,
  contentSecurityPolicyHeaderName,
  generateNonce,
  NONCE_REQUEST_HEADER,
} from "@/lib/security-headers";

/**
 * Attach a nonce-based Content-Security-Policy to every page response.
 *
 * The policy is set twice on purpose. On the *request* headers, because Next
 * finds this request's nonce by parsing the `Content-Security-Policy` (or
 * `-Report-Only`) header of the incoming request and stamps it on the scripts
 * and styles it emits. On the *response* headers, because that is what the
 * browser enforces. Setting the request header also discards any policy a
 * client sent, so a request cannot pick its own nonce.
 *
 * The root layout reads `x-nonce` to stamp the one hand-written inline script
 * (the theme bootstrap). Everything else Next stamps itself.
 *
 * The static headers (`Referrer-Policy`, HSTS, …) are not set here: they are
 * the same for every response, so `next.config.ts` attaches them to API and
 * asset responses as well.
 *
 * In demo mode (#251) a page request with no session cookie is sent to
 * `/api/auth/login?next=<path>` first, which mints a session and comes
 * straight back, so a visitor never sees a sign-in screen. Cookie *presence*
 * only: nothing is verified here, and a forged cookie is still refused by
 * `getIdentity()` on the page. `/api` is outside the matcher, so API routes
 * keep answering 401.
 */
export function proxy(request: NextRequest): NextResponse {
  if (appConfig.authMode === "demo" && needsDemoSession(request)) {
    const { pathname, search } = request.nextUrl;
    const login = new URL("/api/auth/login", requestOrigin(request));
    login.searchParams.set("next", `${pathname}${search}`);
    const response = NextResponse.redirect(login, 307);
    // Per visitor and per Host header; nothing in between may reuse it.
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  const nonce = generateNonce();
  const policy = contentSecurityPolicy({
    nonce,
    development: process.env.NODE_ENV === "development",
  });
  const header = contentSecurityPolicyHeaderName(appConfig.cspReportOnly);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(NONCE_REQUEST_HEADER, nonce);
  requestHeaders.delete("Content-Security-Policy");
  requestHeaders.delete("Content-Security-Policy-Report-Only");
  requestHeaders.set(header, policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(header, policy);
  return response;
}

/**
 * The origin the browser used. The proxy runtime requires an absolute
 * `Location`, and `request.nextUrl` names the server's own bind address, not
 * the host behind a reverse proxy or a Cloudflare Worker, so a redirect built
 * from it would move the visitor off the origin their cookie is set on. The
 * forwarded headers, then `Host`, say where the visitor actually is; a
 * spoofed one only redirects the request's own sender.
 */
function requestOrigin(request: NextRequest): string {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host") || request.nextUrl.host;
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const proto =
    forwardedProto === "https" || forwardedProto === "http"
      ? forwardedProto
      : request.nextUrl.protocol.replace(/:$/, "");
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return request.nextUrl.origin;
  }
}

/**
 * A browser navigation with no session cookie.
 *
 * Only a navigation is redirected: a browser keeps the cookie the login route
 * sets and comes straight back, while a cookie-less client (a health check,
 * a script, curl) would bounce between the page and the login route until it
 * gave up. Cloudflare's container start check fetches `/` exactly that way
 * (#254). Those clients get the page itself, which shows "Enter the demo". A
 * prefetch is left alone too: it cannot follow a redirect that sets a cookie
 * on the visitor's behalf, and the navigation it precedes will redirect anyway.
 */
function needsDemoSession(request: NextRequest): boolean {
  if (request.method !== "GET") return false;
  if (request.cookies.has(appConfig.sessionCookieName)) return false;
  if (
    request.headers.get("next-router-prefetch") ||
    request.headers.get("purpose") === "prefetch"
  ) {
    return false;
  }
  return isNavigation(request);
}

/**
 * `Sec-Fetch-Dest: document` where the browser sends Fetch Metadata (every
 * current one), else an `Accept` that asks for HTML, which every browser sends
 * on a navigation and a bare `fetch()` does not.
 */
function isNavigation(request: NextRequest): boolean {
  const dest = request.headers.get("sec-fetch-dest");
  if (dest) return dest === "document";
  return (request.headers.get("accept") ?? "").includes("text/html");
}

export const config = {
  /*
   * Everything except API routes and build assets. API responses are JSON or
   * an SSE stream, neither of which a document policy applies to, and leaving
   * `/api` out keeps the proxy off the stream path entirely. Prefetches are
   * deliberately *not* excluded: a nonce costs nothing, and a prefetched
   * document served without a policy would be a page without one.
   */
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
