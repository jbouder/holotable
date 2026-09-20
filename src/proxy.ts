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
 */
export function proxy(request: NextRequest): NextResponse {
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
