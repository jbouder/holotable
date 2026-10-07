import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { sessionSecret } from "@/lib/auth/session";

/**
 * A credential at rest: AES-256-GCM under a key derived from `SESSION_SECRET`
 * by HKDF, with a label per purpose (#27, #331).
 *
 * The label is what keeps the uses apart: the session-signing key and every
 * encryption key are different bytes, and a value sealed for one purpose
 * does not open under another's label. GCM authenticates as well as
 * encrypts, so a row edited in the database fails to open rather than
 * yielding a different value.
 *
 * Rotating `SESSION_SECRET` makes every sealed value unreadable. That is the
 * point of deriving from it, and every caller treats `null` from
 * {@link openSecret} as "gone": a session that cannot renew, a model key
 * that has to be entered again.
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;

function encryptionKey(label: string, secret: Uint8Array = sessionSecret()): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "holotable", label, 32));
}

/** iv || tag || ciphertext. */
export function sealSecret(value: string, label: string, secret?: Uint8Array): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(label, secret), iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

/**
 * The value, or null when the bytes do not open under this label and secret:
 * one sealed before `SESSION_SECRET` was rotated, one sealed for another
 * purpose, or one that was tampered with.
 */
export function openSecret(
  sealed: Uint8Array,
  label: string,
  secret?: Uint8Array,
): string | null {
  const buf = Buffer.from(sealed);
  if (buf.length <= IV_BYTES + TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(label, secret),
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
