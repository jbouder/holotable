import { createHash, timingSafeEqual } from "node:crypto";
import { addressInAny, parseCidrList } from "@/lib/cidr";
import type { Environment } from "@/lib/config";

/**
 * Who may read `/api/metrics`.
 *
 * A scrape is an operational X-ray of the deployment: dashboard and source
 * ids, model spend per workspace, what the SQL guard is rejecting. It is not
 * behind the session cookie, because Prometheus does not hold one, so it needs
 * a gate of its own.
 *
 * The endpoint is therefore **closed unless configured**. With neither
 * `METRICS_TOKEN` nor `METRICS_ALLOWED_CIDRS` set it answers 404, the same as
 * a route that does not exist — an unconfigured deployment leaks nothing and
 * advertises nothing.
 *
 * When both are configured they are ANDed, not ORed: setting a token can only
 * ever tighten access. That matters because the address check is only as
 * trustworthy as the proxy in front of it (see {@link clientAddress}), and a
 * spoofable header must never be able to stand in for the token.
 *
 *   | METRICS_TOKEN | METRICS_ALLOWED_CIDRS | requirement          |
 *   | ------------- | --------------------- | -------------------- |
 *   | unset         | unset                 | 404, disabled        |
 *   | set           | unset                 | bearer token         |
 *   | unset         | set                   | source address       |
 *   | set           | set                   | both                 |
 *
 * Both variables are read straight from the environment rather than through
 * `src/lib/config.ts`, for the reason `SESSION_SECRET` is: that module reaches
 * the browser bundle, and a shared secret has no business being in a module
 * that does. They are still validated at startup by `validateConfig`.
 */

export type MetricsAccess =
  | { allowed: true }
  | { allowed: false; status: 404 | 401 | 403; message: string };

const DISABLED: MetricsAccess = {
  allowed: false,
  status: 404,
  message: "metrics are not enabled",
};

/** Decide whether this request may read the scrape. */
export function authorizeMetricsRequest(
  req: Request,
  env: Environment = process.env,
): MetricsAccess {
  const token = env.METRICS_TOKEN ?? "";
  const cidrs = parseCidrList(env.METRICS_ALLOWED_CIDRS ?? "");

  if (!token && cidrs.length === 0) return DISABLED;

  if (token) {
    const presented = bearerToken(req.headers.get("authorization"));
    if (presented === null) {
      return {
        allowed: false,
        status: 401,
        message: "metrics require an Authorization: Bearer token",
      };
    }
    if (!secretsMatch(presented, token)) {
      return { allowed: false, status: 403, message: "invalid metrics token" };
    }
  }

  if (cidrs.length > 0) {
    const address = clientAddress(req);
    if (address === null || !addressInAny(address, cidrs)) {
      return {
        allowed: false,
        status: 403,
        message: "metrics are not exposed to this address",
      };
    }
  }

  return { allowed: true };
}

/** The token from an `Authorization: Bearer …` header, or `null`. */
function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * Compare two secrets without leaking their contents through timing. Hashing
 * first makes the compared buffers the same length whatever the inputs were,
 * which `timingSafeEqual` requires and which also stops the length of the
 * configured token from being probed.
 */
function secretsMatch(presented: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

/**
 * The address the request came from, as this process can see it.
 *
 * Next gives a route handler no socket peer, so this reads
 * `X-Forwarded-For` — the **last** entry, then `X-Real-IP`. The last entry is
 * the one the nearest proxy wrote: a proxy either overwrites the header with
 * the peer it observed or appends that peer to what arrived, so in both cases
 * everything a client could have injected sits to its left.
 *
 * That still means the address check is exactly as trustworthy as the proxy in
 * front of the app. Directly exposed, it is not trustworthy at all — which is
 * why `METRICS_TOKEN`, when set, is required on top rather than as an
 * alternative.
 */
function clientAddress(req: Request): string | null {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded
      .split(",")
      .map((hop) => hop.trim())
      .filter((hop) => hop.length > 0);
    const last = hops.at(-1);
    if (last) return stripPort(last);
  }
  const real = req.headers.get("x-real-ip");
  return real ? stripPort(real.trim()) : null;
}

/** `[::1]:443` and `10.0.0.1:443` both name an address this module can parse. */
function stripPort(value: string): string {
  const bracketed = /^\[(.+)\](?::\d+)?$/.exec(value);
  if (bracketed) return bracketed[1];
  // Only strip a port from IPv4; a bare IPv6 address is full of colons.
  const withPort = /^(\d+\.\d+\.\d+\.\d+):\d+$/.exec(value);
  return withPort ? withPort[1] : value;
}
