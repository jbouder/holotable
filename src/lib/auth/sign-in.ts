import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { type JWTPayload, type JWTVerifyGetKey, jwtVerify } from "jose";
import type { TokenSet } from "@/lib/auth/oidc";

/**
 * The browser half of a sign-in, checked on the way back (#281).
 *
 * `/api/auth/login` makes three random values and keeps each in a short-lived
 * `__Host-` cookie:
 *
 * - `state` ties the callback to a sign-in this browser started.
 * - `nonce` goes to the realm in the authorize request and comes back inside
 *   the id_token, which the realm signs. The callback requires it to equal the
 *   cookie's.
 * - `verifier` is the PKCE code verifier (RFC 7636). Only its SHA-256 goes to
 *   the realm; the verifier itself is sent with the code exchange, and the
 *   realm refuses the code without it.
 *
 * `state` alone did not stop authorization-code injection: someone holding
 * another person's code (from a log, a `Referer`, a shared machine's history)
 * could start their own sign-in, which gives them a valid `state` cookie, and
 * paste that code into the callback. The server would redeem it with its own
 * client secret and sign them in as the other person. The other person's
 * id_token carries the other person's nonce, so the nonce check refuses it;
 * the code was bound to the other person's verifier, so PKCE refuses it at
 * the token endpoint before that.
 */

export interface Handshake {
  state: string;
  nonce: string;
  verifier: string;
}

/** 32 random bytes each, base64url: a verifier of 43 characters, as RFC 7636 allows. */
export function newHandshake(): Handshake {
  const value = () => randomBytes(32).toString("base64url");
  return { state: value(), nonce: value(), verifier: value() };
}

/** The S256 code challenge for a verifier (RFC 7636 §4.2). */
export function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Equal strings, compared without leaking where they differ. */
export function sameValue(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Why a callback was refused. Only `id_token` is not the browser's doing. */
export type SignInRefusal = "state" | "handshake" | "id_token" | "nonce";

export class SignInRefused extends Error {
  constructor(readonly reason: SignInRefusal) {
    super(`sign-in refused: ${reason}`);
    this.name = "SignInRefused";
  }
}

export interface SignInDeps {
  /** Redeem the code at the realm's token endpoint, with the PKCE verifier. */
  exchange: (code: string, verifier: string) => Promise<TokenSet>;
  /** The realm's signing keys, or null when `OIDC_JWKS_URL` is not set. */
  keys: JWTVerifyGetKey | null;
  issuer?: string;
  audience?: string;
}

/**
 * Check a callback and redeem its code. Returns the token set and the
 * id_token's verified claims, or throws {@link SignInRefused}.
 *
 * The browser's half is checked before the code is sent anywhere, so a
 * callback missing its cookies costs nothing at the realm. The id_token is
 * verified against the realm's keys only: a token returned by the token
 * endpoint is never a first-party session token, so the fallback
 * `verifySessionToken` makes for those does not apply here.
 */
export async function completeSignIn(
  params: { code: string | null; state: string | null },
  handshake: Partial<Handshake>,
  deps: SignInDeps,
): Promise<{ tokens: TokenSet; claims: JWTPayload }> {
  const { code, state } = params;
  if (!code || !state || !handshake.state || !sameValue(handshake.state, state)) {
    throw new SignInRefused("state");
  }
  if (!handshake.nonce || !handshake.verifier) throw new SignInRefused("handshake");

  const tokens = await deps.exchange(code, handshake.verifier);
  if (!deps.keys) throw new SignInRefused("id_token");

  let claims: JWTPayload;
  try {
    ({ payload: claims } = await jwtVerify(tokens.id_token, deps.keys, {
      issuer: deps.issuer,
      audience: deps.audience,
    }));
  } catch {
    throw new SignInRefused("id_token");
  }
  if (typeof claims.nonce !== "string" || !sameValue(claims.nonce, handshake.nonce)) {
    throw new SignInRefused("nonce");
  }
  return { tokens, claims };
}
