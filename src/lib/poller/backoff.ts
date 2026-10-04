/**
 * Per-panel failure backoff for the poller (#44).
 *
 * A panel whose execution fails used to be re-run on the next tick, forever,
 * on every dashboard that showed it: a source that is down, or a statement
 * that always times out, turned one outage into steady load on the database
 * least able to take it. Now each panel counts its consecutive failures. Below
 * the threshold nothing changes, since a single blip should not cost a viewer
 * a refresh. From the threshold on, the panel is not executed again until its
 * `retryAt`, and each further failure doubles the wait, up to a ceiling. One
 * success clears it.
 *
 * The decision is pure and lives here; the poller holds the state.
 */

export interface BackoffPolicy {
  /** Consecutive failures before the panel stops running every tick. */
  threshold: number;
  /** The longest the poller waits between attempts at a failing panel. */
  maxMs: number;
}

/** A failing panel's record. A panel that is healthy has none. */
export interface PanelHealth {
  /** Consecutive failed executions, including the last one. */
  failures: number;
  /** When the last attempt started, in epoch ms. */
  lastAttemptAt: number;
  /**
   * The earliest the panel runs again, in epoch ms, or null while it is still
   * under the threshold and runs on every tick.
   */
  retryAt: number | null;
}

/**
 * How long to wait after `failures` consecutive failures, or null when the
 * panel should keep running on its normal cadence.
 *
 * At the threshold the wait is twice the refresh interval, and it doubles with
 * each further failure, so a fifteen-second dashboard waits 30s, 60s, 120s,
 * 240s and then the ceiling. Never less than the interval itself, so a
 * dashboard that refreshes less often than the ceiling is not sped up by its
 * own failures.
 */
export function backoffDelay(
  failures: number,
  intervalMs: number,
  policy: BackoffPolicy,
): number | null {
  if (failures < policy.threshold) return null;
  // Capped before the exponent, so a panel failing for days cannot overflow.
  const doublings = Math.min(failures - policy.threshold + 1, 30);
  return Math.max(intervalMs, Math.min(policy.maxMs, intervalMs * 2 ** doublings));
}

/** The record after a failed attempt that started at `startedAt`. */
export function recordFailure(
  previous: PanelHealth | undefined,
  startedAt: number,
  finishedAt: number,
  intervalMs: number,
  policy: BackoffPolicy,
): PanelHealth {
  const failures = (previous?.failures ?? 0) + 1;
  const delay = backoffDelay(failures, intervalMs, policy);
  return {
    failures,
    lastAttemptAt: startedAt,
    retryAt: delay === null ? null : finishedAt + delay,
  };
}

/** Whether a panel with this record runs on a tick at `now`. */
export function isDue(health: PanelHealth | undefined, now: number): boolean {
  return health?.retryAt == null || now >= health.retryAt;
}

/**
 * Whether a viewer's manual retry runs the panel now. Only a panel that is
 * backing off can be retried (one under the threshold runs on the next tick
 * anyway), and never sooner than `floorMs` after its last attempt: a retry
 * button held down must not become a faster cadence than the dashboard's own.
 */
export function canRetryNow(
  health: PanelHealth | undefined,
  now: number,
  floorMs: number,
): boolean {
  if (!health || health.retryAt === null) return false;
  return now - health.lastAttemptAt >= floorMs;
}
