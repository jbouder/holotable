/**
 * When the live dashboard lets go of its stream (#263).
 *
 * A dashboard's stream is a request that never ends, and anything counting
 * open requests counts it as activity: the hosted demo's container
 * (`@cloudflare/containers` renews its `sleepAfter` while any request is in
 * flight) never sleeps while one tab is open somewhere, and a real deployment
 * keeps a poller subscription querying for a page nobody is looking at.
 *
 * Two rules, both enforced in the browser:
 *
 * - **Hidden tabs suspend.** Once the tab has been hidden for
 *   {@link HIDDEN_STREAM_GRACE_MS} the stream closes, and it reopens when the
 *   tab is shown. Every mode. It is a suspension, not the user's Pause, so a
 *   dashboard the user paused stays paused.
 * - **Idle demo tabs pause.** In demo mode only, a visible tab with no
 *   interaction for {@link DEMO_IDLE_PAUSE_MS} pauses through the ordinary
 *   Pause state and says why. A wall display is the point of a monitoring
 *   dashboard, so outside the demo a visible tab is never paused for being
 *   watched rather than touched.
 *
 * Neither is a security boundary: a scripted client can hold a stream open
 * regardless, and `max_instances: 1` is what bounds that cost on the demo.
 */

/**
 * How long a hidden tab keeps its stream. Long enough that a quick look at
 * another tab does not cost a reconnect, which clears and refills every panel.
 */
export const HIDDEN_STREAM_GRACE_MS = 5 * 60_000;

/**
 * Demo mode: how long a visible tab with no interaction keeps its stream. The
 * container then sleeps `sleepAfter` (30 minutes) later.
 */
export const DEMO_IDLE_PAUSE_MS = 10 * 60_000;

/** What counts as someone being there. `pointermove` is cheap here: see {@link createIdleWatch}. */
export const ACTIVITY_EVENTS = [
  "pointerdown",
  "pointermove",
  "keydown",
  "wheel",
  "touchstart",
] as const;

/** Timer functions, injectable so the logic is testable without a browser. */
export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(id: ReturnType<typeof setTimeout>): void;
}

const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

export interface IdleWatch {
  /** Someone did something. */
  activity(): void;
  /** Stop watching; `onIdle` will not be called afterwards. */
  dispose(): void;
}

/**
 * Calls `onIdle` once, after `idleMs` without {@link IdleWatch.activity}.
 *
 * Activity only records a timestamp; the one pending timer, when it fires,
 * reschedules itself for whatever remains. So a stream of `pointermove`
 * events costs an assignment each, not a `clearTimeout`/`setTimeout` pair.
 */
export function createIdleWatch(
  idleMs: number,
  onIdle: () => void,
  timers: Timers = realTimers,
): IdleWatch {
  let last = timers.now();
  let disposed = false;
  let id = timers.setTimeout(check, idleMs);

  function check() {
    if (disposed) return;
    const remaining = last + idleMs - timers.now();
    if (remaining > 0) {
      id = timers.setTimeout(check, remaining);
      return;
    }
    disposed = true;
    onIdle();
  }

  return {
    activity() {
      last = timers.now();
    },
    dispose() {
      disposed = true;
      timers.clearTimeout(id);
    },
  };
}

export interface HiddenWatch {
  /** The page's visibility changed. */
  visibility(hidden: boolean): void;
  dispose(): void;
}

/**
 * Reports `true` once the page has stayed hidden for `graceMs`, and `false`
 * as soon as it is visible again. Only changes are reported.
 */
export function createHiddenWatch(
  graceMs: number,
  onChange: (suspended: boolean) => void,
  timers: Timers = realTimers,
): HiddenWatch {
  let suspended = false;
  let id: ReturnType<typeof setTimeout> | undefined;

  function cancel() {
    if (id !== undefined) timers.clearTimeout(id);
    id = undefined;
  }

  return {
    visibility(hidden) {
      if (hidden) {
        if (suspended || id !== undefined) return;
        id = timers.setTimeout(() => {
          id = undefined;
          suspended = true;
          onChange(true);
        }, graceMs);
        return;
      }
      cancel();
      if (suspended) {
        suspended = false;
        onChange(false);
      }
    },
    dispose: cancel,
  };
}
