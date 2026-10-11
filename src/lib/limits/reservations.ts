/**
 * Model calls admitted and not yet settled (#496).
 *
 * The daily token budget is read before a call and its usage written after
 * it, so calls admitted together all saw the same headroom and could each
 * spend it. A reservation closes that gap: admission reserves an estimate
 * against the workspace's day, the next admission counts it as spent, and
 * the call's real usage settles it. A call that never settles (a crash, a
 * client gone) has its reservation expire at the model deadline.
 *
 * Open reservations are also the calls in flight, which is what the global
 * cap (`LLM_MAX_IN_FLIGHT`) counts.
 *
 * In-process, like the rate limiter's buckets: with one instance (the
 * supported shape) it is exact; with several, each holds its own.
 */

/** Tokens reserved per call before its usage is known. */
export const RESERVE_TOKENS_PER_CALL = 8_000;

interface Reservation {
  workspaceId: string;
  day: string;
  tokens: number;
  expiresAt: number;
}

export class LlmReservations {
  private open = new Map<number, Reservation>();
  private next = 1;

  private sweep(now: number): void {
    for (const [id, r] of this.open) if (r.expiresAt <= now) this.open.delete(id);
  }

  /** Tokens reserved and unsettled for one workspace's day. */
  reserved(workspaceId: string, day: string, now: number): number {
    this.sweep(now);
    let total = 0;
    for (const r of this.open.values()) {
      if (r.workspaceId === workspaceId && r.day === day) total += r.tokens;
    }
    return total;
  }

  /** Calls admitted and not yet settled, across every workspace. */
  inFlight(now: number): number {
    this.sweep(now);
    return this.open.size;
  }

  /** Reserve for one call; returns its settlement, which is safe to call twice. */
  reserve(input: Reservation): () => void {
    const id = this.next++;
    this.open.set(id, input);
    return () => {
      this.open.delete(id);
    };
  }
}
