import { z } from "zod";
import type { Identity } from "@/lib/auth/claims";
import { sessionSecret } from "@/lib/auth/session";

/**
 * Read-only share links (#65): a token that lets whoever holds it view one
 * dashboard, live, and nothing else.
 *
 * The token is signed with a key derived from `SESSION_SECRET`, so the proxy
 * can read which origins may frame the embed without a database call. It
 * carries no authority on its own: every use loads the share's row and
 * refuses a token that is revoked, expired, for another dashboard, or not
 * the one the row was minted with (its SHA-256 is stored, never the token).
 * What a valid token yields is a share identity, which `can()` allows exactly
 * `dashboard:view` on its one dashboard; the token is accepted only by the
 * embed page and the dashboard stream, never by `getIdentity()`, so no other
 * route can be reached with one at all.
 */

export const SHARE_TOKEN_PREFIX = "hts_";

/** What the token says. Short names: it travels in a URL. */
export interface ShareClaims {
  /** The share's row id. */
  sid: string;
  /** The one dashboard it shows. */
  did: string;
  /** Expiry, epoch seconds. */
  exp: number;
  /** Origins that may frame the embed; none means it cannot be framed. */
  org: string[];
}

const Claims = z
  .object({
    sid: z.uuid(),
    did: z.uuid(),
    exp: z.number().int().positive(),
    org: z.array(z.string()).max(10),
  })
  .strict();

/**
 * An origin that may embed a share: `https://host[:port]`, or plain http on
 * localhost for development. Exact origins only — no paths, no wildcards —
 * because each one is written into a `frame-ancestors` directive.
 */
export const ShareOrigin = z
  .string()
  .max(200)
  .regex(
    /^(https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?|http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?)$/,
    "an origin is https://host[:port] (or http://localhost), with no path",
  );

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** A key of its own, so a share token can never pass as a session token or back. */
async function shareKey(): Promise<CryptoKey> {
  const root = await crypto.subtle.importKey(
    "raw",
    sessionSecret() as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const derived = await crypto.subtle.sign(
    "HMAC",
    root,
    encoder.encode("holotable share token v1"),
  );
  return crypto.subtle.importKey(
    "raw",
    derived,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signShareToken(claims: ShareClaims): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify(Claims.parse(claims))));
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", await shareKey(), encoder.encode(payload)),
  );
  return `${SHARE_TOKEN_PREFIX}${payload}.${base64url(signature)}`;
}

/**
 * The claims of a token that is well formed, signed by this server and not
 * expired; null for anything else. Says nothing about revocation: that is
 * the row's, and every use checks it.
 */
export async function verifyShareToken(
  token: unknown,
  now: number = Date.now(),
): Promise<ShareClaims | null> {
  if (typeof token !== "string" || token.length > 2_048) return null;
  if (!token.startsWith(SHARE_TOKEN_PREFIX)) return null;
  const [payload, signature, extra] = token.slice(SHARE_TOKEN_PREFIX.length).split(".");
  if (!payload || !signature || extra !== undefined) return null;
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      "HMAC",
      await shareKey(),
      Buffer.from(signature, "base64url") as BufferSource,
      encoder.encode(payload),
    );
  } catch {
    return null;
  }
  if (!valid) return null;
  let parsed: z.ZodSafeParseResult<ShareClaims>;
  try {
    parsed = Claims.safeParse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
  } catch {
    return null;
  }
  if (!parsed.success) return null;
  if (parsed.data.exp * 1000 <= now) return null;
  return parsed.data;
}

/** The SHA-256 the row keeps in place of the token. */
export async function shareTokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return Buffer.from(digest).toString("hex");
}

/**
 * The `frame-ancestors` sources for an embed response: the share's own
 * origins, re-checked here because they are written into a header, or
 * `'none'`.
 */
export function shareFrameAncestors(claims: ShareClaims | null): string {
  const origins = (claims?.org ?? []).filter((o) => ShareOrigin.safeParse(o).success);
  return origins.length > 0 ? origins.join(" ") : "'none'";
}

/** What a share is, as `can()` and the stream see it. */
export interface ShareGrant {
  shareId: string;
  dashboardId: string;
  workspaceId: string;
}

/**
 * The identity a valid share resolves to: no workspace roles, never an
 * admin, and a grant `can()` reads before anything else. Its subject names
 * the share, which is what the audit log records it as.
 */
export function shareIdentity(grant: ShareGrant): Identity {
  return {
    sub: `share:${grant.shareId}`,
    platformAdmin: false,
    workspaces: {},
    share: grant,
  };
}

/** What a revocation names a share's open streams by. */
export function shareSessionId(shareId: string): string {
  return `share:${shareId}`;
}
