import type { Identity } from "@/lib/auth/claims";
import { isRevoked, onRevoke, type TokenRef } from "@/lib/auth/revocation";
import { log } from "@/lib/log";

/**
 * How long a dashboard stream stays authorized (#32).
 *
 * The stream route authorizes a subscriber once, when it connects, and the
 * response then stays open for as long as the browser keeps it. Without this,
 * that one check would outlive the session token it was made with: a stream
 * opened a minute before expiry would keep delivering for hours. So each
 * stream is tied to the token it was opened with:
 *
 * - at the token's `exp` the stream is ended as `expired`. The browser renews
 *   its session (or finds it already renewed) and reconnects with its last
 *   event id, which resumes without a gap (#43), and the reconnect is
 *   authorized again from the new token. That reconnect is how a group the
 *   realm removed reaches an open stream: the renewed token no longer carries
 *   it. The bound is one session-token lifetime, half the realm's refresh
 *   lifetime (#27);
 * - a revocation of the stream's session ends it at once as `revoked` (#28);
 * - every `intervalMs` the token is verified again and the identity is
 *   re-authorized against the dashboard as it is now, so a dashboard deleted
 *   or moved out of the subscriber's workspaces ends the stream as
 *   `forbidden`.
 *
 * The stream cannot see the browser's newer cookie: a request's cookies are
 * fixed when it is made. That is why expiry ends the stream rather than
 * extending it.
 *
 * Each stream is guarded on its own, so ending one never touches the other
 * subscribers of the same shared poller.
 */

/** Why the server ended a stream; what the browser should do next differs. */
export type StreamEnd = "expired" | "revoked" | "forbidden";

export interface StreamGuardOptions {
  /** When the stream's session token expires, epoch ms. */
  expiresAt: number | null;
  /** What a revocation would name the stream's session by. */
  ref: TokenRef | null;
  /** How often to verify and re-authorize, ms. */
  intervalMs: number;
  /** Verify the stream's token again: the identity, or null if it no longer verifies. */
  verify(): Promise<Identity | null>;
  /** May this identity still view the dashboard, as the dashboard is now? */
  authorize(identity: Identity): Promise<boolean>;
  /** Called at most once, after the guard has stopped. */
  onEnd(why: StreamEnd): void;
  now?: () => number;
}

/** `setTimeout` holds a 32-bit delay; a longer one fires at once. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** Guard one stream. Returns the stop, for a stream that closed for another reason. */
export function guardStream(options: StreamGuardOptions): () => void {
  const { expiresAt, ref } = options;
  const now = options.now ?? Date.now;
  let done = false;
  let checking = false;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  const expired = () => expiresAt !== null && now() >= expiresAt;

  const stop = () => {
    done = true;
    clearTimeout(expiryTimer);
    clearInterval(interval);
    stopListening();
  };

  const end = (why: StreamEnd) => {
    if (done) return;
    stop();
    options.onEnd(why);
  };

  const scheduleExpiry = () => {
    if (expiresAt === null) return;
    const delay = Math.max(0, expiresAt - now());
    expiryTimer = setTimeout(
      () => {
        if (expired()) end("expired");
        else scheduleExpiry();
      },
      Math.min(delay, MAX_TIMEOUT_MS),
    );
  };

  const recheck = async () => {
    if (done || checking) return;
    checking = true;
    try {
      if (expired()) return end("expired");
      const identity = await options.verify();
      if (done) return;
      // A token that stopped verifying before its expiry was revoked, or
      // signed by a key the realm has since dropped; either way, sign in.
      if (!identity) return end(expired() ? "expired" : "revoked");
      const allowed = await options.authorize(identity);
      if (!done && !allowed) end("forbidden");
    } catch (err) {
      // The dashboard lookup failed. The token still verified and the last
      // authorization still holds, so the stream carries on and the next
      // check tries again; ending it would only send the browser back to a
      // route that cannot answer either.
      log.warn("stream.recheck_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      checking = false;
    }
  };

  // Registered before the first check can run, so a revocation in between
  // is not missed.
  const stopListening = onRevoke(() => {
    if (ref && isRevoked(ref)) end("revoked");
  });
  const interval = setInterval(() => void recheck(), options.intervalMs);
  scheduleExpiry();
  return stop;
}
