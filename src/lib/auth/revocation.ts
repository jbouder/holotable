/**
 * Sessions the realm has ended before their tokens expired (#28).
 *
 * A session token is stateless: verifying it reads no database, which is why
 * every request can afford to. So when Keycloak ends a session through
 * back-channel logout, something has to tell `verifySessionToken` that a token
 * it would otherwise accept is no longer good. That is this set, consulted on
 * every verification and cheap enough to be.
 *
 * Process-local, because Holotable runs as one instance by design
 * (architecture/scaling). An entry is kept as long as the longest token that
 * could carry it, then forgotten. A restart forgets every entry: a revoked
 * session token then works again until it expires, at most one token lifetime
 * (15 minutes against a default realm), and cannot be renewed, because the
 * `sessions` row it would renew from was deleted with the revocation.
 *
 * Two shapes of revocation, after the logout token:
 * - by `sid`: that realm session's tokens issued up to now. A later one is
 *   good: a realm session Keycloak ended issues none, and one this app's
 *   sign-out ended (the realm's goes on) must still sign the person back in,
 *   with a token issued after it. Tokens minted before session tokens
 *   carried a `sid` cannot be matched to a realm session, so for those the
 *   subject's sid-less tokens are revoked too.
 * - by `sub` alone: every session of that person, issued up to now.
 */

/** As long as the longest session token can live. */
export const REVOCATION_HOLD_MS = 8 * 60 * 60 * 1000;

export interface TokenRef {
  sub: string;
  /** The realm session id the token carries, when it carries one. */
  sid: string | null;
  /** Issued-at, epoch seconds. */
  iat: number;
  /**
   * The moment the token was issued, or a moment it cannot have been issued
   * before, in epoch ms, when this app knows one. Compared exactly, so a
   * token from a fresh sign-in in the same second as a sign-out is not taken
   * for one the sign-out revoked. Absent, the whole second of `iat` counts.
   */
  issuedAtMs?: number;
}

interface SubjectRevocation {
  /** Epoch ms: every token issued at or before this second is revoked. */
  allAt: number;
  /** Epoch ms: tokens with no `sid` issued at or before this second are. */
  sidlessAt: number;
  forgetAt: number;
}

interface SidRevocation {
  /** Epoch ms: this session's tokens issued at or before this second are revoked. */
  at: number;
  forgetAt: number;
}

const sids = new Map<string, SidRevocation>();
const subjects = new Map<string, SubjectRevocation>();
const listeners = new Set<() => void>();

function prune(now: number): void {
  for (const [sid, r] of sids) if (r.forgetAt <= now) sids.delete(sid);
  for (const [sub, r] of subjects) if (r.forgetAt <= now) subjects.delete(sub);
}

/**
 * End sessions now. At least one of `sub` and `sid` is required. Listeners —
 * the open dashboard streams — are told afterwards, so each can check whether
 * it belonged to what was revoked.
 */
export function revoke(target: { sub?: string; sid?: string }, now = Date.now()): void {
  if (!target.sub && !target.sid) return;
  prune(now);
  const forgetAt = now + REVOCATION_HOLD_MS;
  if (target.sid) sids.set(target.sid, { at: now, forgetAt });
  if (target.sub) {
    const prior = subjects.get(target.sub);
    subjects.set(target.sub, {
      // A logout naming a realm session revokes only the subject's sid-less
      // tokens; one naming the subject alone revokes all of them.
      allAt: target.sid ? (prior?.allAt ?? 0) : now,
      sidlessAt: now,
      forgetAt,
    });
  }
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* one stream's failure to close is not another's problem */
    }
  }
}

export function isRevoked(ref: TokenRef, now = Date.now()): boolean {
  // Exactly, when the issue time is known to the millisecond. Otherwise in
  // whole seconds, because `iat` is: a token issued in the second of the
  // revocation is revoked with it, which errs the safe way.
  const issuedBy = (at: number) =>
    ref.issuedAtMs !== undefined
      ? ref.issuedAtMs <= at
      : ref.iat <= Math.floor(at / 1000);
  if (ref.sid !== null) {
    const session = sids.get(ref.sid);
    if (session && session.forgetAt > now && issuedBy(session.at)) return true;
  }
  const subject = subjects.get(ref.sub);
  if (!subject || subject.forgetAt <= now) return false;
  return issuedBy(ref.sid === null ? subject.sidlessAt : subject.allAt);
}

/** Called after every revocation. Returns the unsubscribe. */
export function onRevoke(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tests only: forget everything. */
export function resetRevocations(): void {
  sids.clear();
  subjects.clear();
  listeners.clear();
}
