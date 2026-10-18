import { type NextRequest, NextResponse } from "next/server";
import { embedAppearance, embedAppearanceHeader } from "@/lib/embed-appearance";
import { operatorTheme } from "@/lib/operator-theme";
import { publicOrigin } from "@/lib/auth/origin";
import { config as appConfig, hasRealm } from "@/lib/config";
import { shareFrameAncestors, verifyShareToken } from "@/lib/auth/share";
import {
  contentSecurityPolicy,
  EMBED_APPEARANCE_HEADER,
  EMBED_PATH_PREFIX,
  EMBED_REQUEST_HEADER,
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
 * A page request with no session cookie is sent to
 * `/api/auth/login?next=<path>` first, so nobody stops at a sign-in card on
 * the way in. With a realm, that route renews a session that has only
 * expired, else goes to Keycloak, and comes back to `next`; in demo or local
 * mode (#251, #600) it mints a session and comes straight back. The card is still what
 * an expired or invalid cookie gets, and what someone who just signed out
 * gets (the signed-out cookie): the realm's own session would otherwise sign
 * them straight back in. Cookie *presence* only: nothing is verified here,
 * and a forged cookie is still refused by `getIdentity()` on the page. `/api`
 * is outside the matcher, so API routes keep answering 401.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  // A share link's embed page (#65) runs on its token, not a session, and may
  // be framed by the origins that token names. The signature is checked here
  // only to read those origins; the page itself checks the token against its
  // row, so a revoked one framed by an allowed origin still shows nothing.
  const embed = request.nextUrl.pathname.startsWith(EMBED_PATH_PREFIX);
  if (!embed && needsSession(request)) {
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
    ...(embed
      ? {
          frameAncestors: shareFrameAncestors(
            await verifyShareToken(request.nextUrl.searchParams.get("token")),
          ),
        }
      : {}),
  });
  const header = contentSecurityPolicyHeaderName(appConfig.cspReportOnly);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(NONCE_REQUEST_HEADER, nonce);
  requestHeaders.delete("Content-Security-Policy");
  requestHeaders.delete("Content-Security-Policy-Report-Only");
  requestHeaders.set(header, policy);
  // The root layout leaves out the app's chrome for an embed; set here so a
  // request cannot claim it, and cleared on every other path.
  requestHeaders.delete(EMBED_REQUEST_HEADER);
  requestHeaders.delete(EMBED_APPEARANCE_HEADER);
  if (embed) {
    requestHeaders.set(EMBED_REQUEST_HEADER, "1");
    // The link's theme and scheme (#509), validated; only offered names pass,
    // the operator's (#508) among them once it has loaded.
    operatorTheme();
    requestHeaders.set(
      EMBED_APPEARANCE_HEADER,
      embedAppearanceHeader(embedAppearance(request.nextUrl.searchParams)),
    );
  }

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
  return publicOrigin(request.headers, new URL(request.nextUrl.href));
}

/**
 * A browser navigation with no session cookie, from someone who has not just
 * signed out (with a realm; a demo visitor or the local owner has nothing to sign out of).
 *
 * Only a navigation is redirected: a browser keeps the cookie the login route
 * sets and comes straight back, while a cookie-less client (a health check,
 * a script, curl) would bounce between the page and the login route until it
 * gave up. Cloudflare's container start check fetches `/` exactly that way
 * (#254). Those clients get the page itself, which shows the sign-in card. A
 * prefetch is left alone too: it cannot follow a redirect that sets a cookie
 * on the visitor's behalf, and the navigation it precedes will redirect anyway.
 */
function needsSession(request: NextRequest): boolean {
  if (request.method !== "GET") return false;
  if (request.cookies.has(appConfig.sessionCookieName)) return false;
  if (
    hasRealm(appConfig.authMode) &&
    request.cookies.has(appConfig.signedOutCookieName)
  ) {
    return false;
  }
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
   * Everything except API routes, the well-known metadata and build assets.
   * API responses are JSON or an SSE stream, neither of which a document
   * policy applies to, and leaving `/api` out keeps the proxy off the stream
   * path entirely; `/.well-known` is JSON an MCP client reads with no cookie
   * (#149), which the sign-in redirect must never answer for. Prefetches are
   * deliberately *not* excluded: a nonce costs nothing, and a prefetched
   * document served without a policy would be a page without one.
   */
  matcher: ["/((?!api|\\.well-known|_next/static|_next/image|icon.svg).*)"],
};
