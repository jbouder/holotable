import { createHash, randomBytes } from "node:crypto";
import { openSecret, sealSecret } from "@/lib/secrets/seal";

/**
 * The refresh token at rest, and the opaque id that names it (#27).
 *
 * The realm's refresh token is the one credential in Holotable that outlives
 * a session token, so it is never sent to the browser and never stored in
 * clear. It is sealed with AES-256-GCM under a key derived from
 * `SESSION_SECRET` by HKDF with its own label, so the signing key and the
 * encryption key are never the same bytes. GCM authenticates as well as
 * encrypts: a row edited in the database fails to open rather than yielding a
 * different token.
 *
 * The browser carries only a random session id. The table keys rows by a
 * SHA-256 of it, so reading the table does not yield a usable cookie value.
 */

const KEY_LABEL = "holotable refresh-token v1";

/** iv || tag || ciphertext, sealed by `src/lib/secrets/seal.ts`. */
export function sealRefreshToken(token: string, secret?: Uint8Array): Buffer {
  return sealSecret(token, KEY_LABEL, secret);
}

/**
 * The token, or null when the bytes do not open under this secret — a row
 * written before `SESSION_SECRET` was rotated, or one that was tampered with.
 * Either way the session cannot be renewed, which is the caller's answer.
 */
export function openRefreshToken(sealed: Uint8Array, secret?: Uint8Array): string | null {
  return openSecret(sealed, KEY_LABEL, secret);
}

/** 256 random bits, base64url: the value of the session-id cookie. */
export function newSessionId(): string {
  return randomBytes(32).toString("base64url");
}

/** What the `sessions` table is keyed by. */
export function hashSessionId(id: string): string {
  return createHash("sha256").update(id, "utf8").digest("hex");
}
