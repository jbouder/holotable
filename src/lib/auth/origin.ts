/**
 * Same-origin check on state-changing requests (#25).
 *
 * The session cookie is `SameSite=Lax`, which keeps a cross-site POST from
 * carrying it. That is the only thing stopping a forged request today, and it
 * has two gaps: a page on a sibling subdomain is same-*site*, so Lax lets its
 * forms carry the cookie, and a future move to `SameSite=None` (embedding,
 * #65) would remove it entirely. This is the second, independent layer: every
 * request whose method can change something must come from this app's own
 * origin, or from one named in `ALLOWED_ORIGINS`.
 *
 * The browser is asked first. `Sec-Fetch-Site` is set by the browser itself
 * and a page cannot forge it: `same-origin` is our own page and `none` is the
 * person acting directly (a bookmark, the address bar). Older browsers without
 * Fetch Metadata still send `Origin` on every POST, which is compared with the
 * origin the request was addressed to. A request with neither header did not
 * come from a page at all (a script, `curl`, the realm's back-channel logout),
 * so it is not the attack this defends against, and is left to authentication
 * like any other.
 *
 * Pure, so it can be tested without a server: the `route()` wrapper in
 * `src/lib/http.ts` calls it before any handler runs.
 */

/** Methods that never change state, and so are never checked. */
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

function firstValue(raw: string | null): string | undefined {
  return raw?.split(",")[0]?.trim() || undefined;
}

/**
 * The origin the browser addressed. Behind a reverse proxy or the demo's
 * Cloudflare Worker the server's own URL is its bind address, so the
 * forwarded headers, then `Host`, say where the visitor actually is. A page
 * cannot set any of these on a cross-origin request, so a forged request
 * cannot use them to pass the check; a spoofed one only misleads its own
 * sender.
 */
export function publicOrigin(headers: Headers, fallback: URL): string {
  const host =
    firstValue(headers.get("x-forwarded-host")) ?? headers.get("host") ?? fallback.host;
  const forwardedProto = firstValue(headers.get("x-forwarded-proto"));
  const proto =
    forwardedProto === "https" || forwardedProto === "http"
      ? forwardedProto
      : fallback.protocol.replace(/:$/, "");
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return fallback.origin;
  }
}

export type OriginVerdict =
  | { ok: true }
  | { ok: false; reason: "cross-site" | "foreign-origin" | "opaque-origin" };

/**
 * Whether a request may proceed. `allowed` is `ALLOWED_ORIGINS`: exact
 * origins (`https://grafana.example.com`), never patterns.
 */
export function checkOrigin(
  method: string,
  url: string,
  headers: Headers,
  allowed: readonly string[],
): OriginVerdict {
  if (SAFE_METHODS.has(method.toUpperCase())) return { ok: true };

  const site = headers.get("sec-fetch-site");
  if (site === "same-origin" || site === "none") return { ok: true };

  const origin = headers.get("origin");
  if (origin === null) {
    // A browser that sends Fetch Metadata sends `Origin` on every POST, so
    // `same-site` or `cross-site` with no origin to allowlist is refused.
    return site === null ? { ok: true } : { ok: false, reason: "cross-site" };
  }
  // A sandboxed iframe, a `data:` page, a redirect across origins.
  if (origin === "null") return { ok: false, reason: "opaque-origin" };
  if (allowed.includes(origin)) return { ok: true };
  // Fetch Metadata already said this is not our own page.
  if (site !== null) return { ok: false, reason: "cross-site" };

  const target = new URL(url);
  const addressed = new Set([target.origin, publicOrigin(headers, target)]);
  return addressed.has(origin) ? { ok: true } : { ok: false, reason: "foreign-origin" };
}

/** An entry `ALLOWED_ORIGINS` can hold: an http(s) origin and nothing else. */
export function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") && url.origin === value
    );
  } catch {
    return false;
  }
}

/** `ALLOWED_ORIGINS` as a list: comma- or whitespace-separated. */
export function splitOrigins(raw: string): string[] {
  return [...new Set(raw.split(/[\s,]+/).filter(Boolean))];
}
