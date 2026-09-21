/**
 * Token-bucket rate limiting.
 *
 * A bucket holds at most `perMinute` tokens and refills continuously at
 * `perMinute` tokens per minute, so a caller may burst up to one minute's
 * allowance and then sustain the configured rate. Buckets are keyed by the
 * caller (`(workspaceId, sub)` for the LLM routes) and live in a
 * {@link RateLimitStore}, so the in-memory store used by a single instance can
 * be swapped for a shared one without touching the callers.
 *
 * The limiter never consults the request: keys are built by the server from
 * the validated identity and the workspace resolved from a trusted record.
 */

export interface RateLimitPolicy {
  /** Sustained requests per minute; also the burst capacity. `0` disables the limit. */
  perMinute: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Whole tokens left in the bucket after this decision. */
  remaining: number;
  /** Milliseconds until one token is available again; `0` when allowed. */
  retryAfterMs: number;
}

export interface RateLimitStore {
  /**
   * Take one token from the bucket at `key`, refilling by `policy` first.
   * Must be atomic per key: two concurrent takes never both succeed on the
   * last token.
   */
  take(key: string, policy: RateLimitPolicy, now: number): Promise<RateLimitDecision>;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/** Pure bucket arithmetic, shared by every store and directly testable. */
export function takeToken(
  bucket: Bucket | undefined,
  policy: RateLimitPolicy,
  now: number,
): { bucket: Bucket; decision: RateLimitDecision } {
  const capacity = policy.perMinute;
  const perMs = capacity / 60_000;
  const elapsed = bucket ? Math.max(0, now - bucket.updatedAt) : 0;
  const refilled = bucket
    ? Math.min(capacity, bucket.tokens + elapsed * perMs)
    : capacity;

  if (refilled >= 1) {
    const tokens = refilled - 1;
    return {
      bucket: { tokens, updatedAt: now },
      decision: { allowed: true, remaining: Math.floor(tokens), retryAfterMs: 0 },
    };
  }
  return {
    bucket: { tokens: refilled, updatedAt: now },
    decision: {
      allowed: false,
      remaining: 0,
      retryAfterMs: Math.ceil((1 - refilled) / perMs),
    },
  };
}

/**
 * In-memory store for a single instance. Full buckets are indistinguishable
 * from absent ones, so they are swept periodically to keep the map bounded by
 * the number of callers active in the last minute rather than ever seen.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, Bucket>();
  private takes = 0;

  constructor(private readonly sweepEvery = 1_000) {}

  async take(
    key: string,
    policy: RateLimitPolicy,
    now: number,
  ): Promise<RateLimitDecision> {
    if (policy.perMinute <= 0) {
      return { allowed: true, remaining: Number.POSITIVE_INFINITY, retryAfterMs: 0 };
    }
    const { bucket, decision } = takeToken(this.buckets.get(key), policy, now);
    this.buckets.set(key, bucket);
    if (++this.takes % this.sweepEvery === 0) this.sweep(now);
    return decision;
  }

  /** Drop buckets that have had a full minute to refill: they are full again. */
  sweep(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt >= 60_000) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}
