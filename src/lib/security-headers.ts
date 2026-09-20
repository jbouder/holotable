/**
 * The HTTP security header baseline.
 *
 * Two consumers, kept deliberately dependency-free so both can import it:
 *
 * - `next.config.ts` attaches {@link staticSecurityHeaders} to every response,
 *   API routes and static assets included. They are the same for every request,
 *   so they can be fixed at build time.
 * - `src/proxy.ts` attaches the `Content-Security-Policy` to every HTML
 *   response. It needs a fresh nonce per request, so it cannot live in the
 *   config; Next reads the nonce back out of the header and stamps it on the
 *   scripts and styles it emits.
 *
 * The app renders model-influenced text (titles, descriptions, SQL), so the
 * policy is the last line against a rendering bug turning into script
 * execution: no inline script runs without this request's nonce, nothing loads
 * from another origin, and the page cannot be framed (the embed mode in #65
 * relaxes `frame-ancestors` per response when it lands).
 */

export interface SecurityHeader {
  key: string;
  value: string;
}

/** One year, the minimum for HSTS preload lists. */
const HSTS_MAX_AGE_SECONDS = 31_536_000;

/**
 * Headers that are the same for every response. HSTS is production-only:
 * `next dev` serves plain http, and a browser that has seen the header for
 * `localhost` refuses http://localhost for every other project for a year.
 */
export function staticSecurityHeaders(opts: { production: boolean }): SecurityHeader[] {
  const headers: SecurityHeader[] = [
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    // Redundant with `frame-ancestors` for browsers that support CSP, kept for
    // the ones that do not.
    { key: "X-Frame-Options", value: "DENY" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), payment=()",
    },
  ];
  if (opts.production) {
    headers.push({
      key: "Strict-Transport-Security",
      value: `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains`,
    });
  }
  return headers;
}

/** The request header the proxy uses to hand the nonce to the render. */
export const NONCE_REQUEST_HEADER = "x-nonce";

/** 128 random bits, base64: the nonce Next stamps on every script it emits. */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export interface ContentSecurityPolicyOptions {
  /** This request's nonce, from {@link generateNonce}. */
  nonce: string;
  /**
   * `next dev` needs two relaxations production does not: React rebuilds
   * server error stacks with `eval`, and hot reload runs over a WebSocket.
   */
  development: boolean;
}

/**
 * Build the policy for one response. Directives follow the Next 16 strict-CSP
 * guide with two additions the app needs:
 *
 * - `style-src-attr 'unsafe-inline'`: client components such as the dashboard
 *   grid set `style={{…}}`, and React server-renders those as `style=""`
 *   attributes. A nonce cannot cover an attribute, and `'unsafe-inline'` is
 *   ignored in a directive that also carries a nonce, so attributes get their
 *   own directive. `<style>` elements still need the nonce.
 * - `connect-src`: same origin only, which is where every API route and the
 *   SSE stream live.
 */
export function contentSecurityPolicy(opts: ContentSecurityPolicyOptions): string {
  const { nonce, development } = opts;
  const directives: string[] = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${development ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  return directives.join("; ");
}

/**
 * Which header carries the policy. Report-only mode sends the same policy
 * under a name the browser logs violations for but does not enforce, so a
 * deployment can watch its console before turning enforcement on.
 */
export function contentSecurityPolicyHeaderName(reportOnly: boolean): string {
  return reportOnly ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy";
}
