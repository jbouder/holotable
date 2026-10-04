import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { sessionSecret } from "@/lib/auth/session";

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

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_LABEL = "holotable refresh-token v1";

function encryptionKey(secret: Uint8Array = sessionSecret()): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "holotable", KEY_LABEL, 32));
}

/** iv || tag || ciphertext. */
export function sealRefreshToken(token: string, secret?: Uint8Array): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  const body = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

/**
 * The token, or null when the bytes do not open under this secret — a row
 * written before `SESSION_SECRET` was rotated, or one that was tampered with.
 * Either way the session cannot be renewed, which is the caller's answer.
 */
export function openRefreshToken(sealed: Uint8Array, secret?: Uint8Array): string | null {
  const buf = Buffer.from(sealed);
  if (buf.length <= IV_BYTES + TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(secret),
      buf.subarray(0, IV_BYTES),
    );
    decipher.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(buf.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

/** 256 random bits, base64url: the value of the session-id cookie. */
export function newSessionId(): string {
  return randomBytes(32).toString("base64url");
}

/** What the `sessions` table is keyed by. */
export function hashSessionId(id: string): string {
  return createHash("sha256").update(id, "utf8").digest("hex");
}
