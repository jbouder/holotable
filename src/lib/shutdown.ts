import { config } from "@/lib/config";

/**
 * Graceful shutdown.
 *
 * On a rolling deploy or a pod eviction the process is sent `SIGTERM` and then
 * killed. Without a handler that window is wasted: SSE sockets die mid-frame,
 * `EventSource` reconnects into the terminating instance, and metric queries
 * are abandoned with their transactions open.
 *
 * The sequence, in order, all of it bounded by `SHUTDOWN_GRACE_MS`:
 *
 *   1. set the drain flag, so `/api/ready` starts failing and the load
 *      balancer stops routing here. `/api/health` deliberately stays green:
 *      liveness is about the process, and restarting one that is on its way
 *      out is the wrong cure.
 *   2. stop every poller, so no new metric query is issued.
 *   3. run the drain hooks — one per open SSE stream — which send a `retry:`
 *      hint and close the socket, so clients come back to a healthy instance
 *      on a spread-out delay rather than all at once.
 *   4. wait for in-flight queries.
 *   5. close the config-store pool.
 *
 * The exit code is always 0: a drain that timed out is still an orderly stop,
 * and a non-zero code would make an orchestrator report a failed shutdown for
 * every slow query.
 *
 * Next installs its own `SIGTERM`/`SIGINT` handlers, which exit 143 and would
 * race this one, so `NEXT_MANUAL_SIG_HANDLE=true` is set in the `start` script
 * and in the runtime image to hand the signal over. The HTTP server is
 * deliberately *not* closed: readiness has already taken this instance out of
 * rotation, and leaving the listener up means a request that arrives during
 * the drain is served rather than refused.
 */

/** Runs when the process begins draining. Registered per open SSE stream. */
export type DrainHook = () => void | Promise<void>;

let draining = false;
let inFlight = 0;
const idleWaiters = new Set<() => void>();
const drainHooks = new Set<DrainHook>();
let shuttingDown: Promise<number> | null = null;
let handlersInstalled = false;

/** Mark the process as draining. Idempotent; there is no way back. */
export function beginDrain(): void {
  draining = true;
}

export function isDraining(): boolean {
  return draining;
}

/**
 * Register a hook to run when the process begins draining. Returns an
 * unregister function; a stream that closes on its own must call it, or the
 * hook set grows with every connection the instance ever served.
 */
export function onDrain(hook: DrainHook): () => void {
  drainHooks.add(hook);
  return () => {
    drainHooks.delete(hook);
  };
}

/**
 * Count `work` as in flight until it settles, so shutdown waits for it.
 *
 * Wraps the metrics-store queries, which open their own short-lived `pg`
 * `Client` per execution. The config store does not need this: its work is
 * checked out of the shared pool, and `pool.end()` already waits for every
 * checked-out client to be released.
 */
export function trackInFlight<T>(work: () => Promise<T>): Promise<T> {
  inFlight += 1;
  let started: Promise<T>;
  try {
    started = work();
  } catch (err) {
    // A thunk that throws before it awaits anything still failed a query, not
    // the call site: keep the rejection asynchronous so every caller can treat
    // the result as one promise.
    settle();
    return Promise.reject(err);
  }
  return started.then(
    (value) => {
      settle();
      return value;
    },
    (err) => {
      settle();
      throw err;
    },
  );
}

function settle(): void {
  inFlight -= 1;
  if (inFlight > 0) return;
  for (const wake of idleWaiters) wake();
  idleWaiters.clear();
}

export function inFlightCount(): number {
  return inFlight;
}

/** Resolves once nothing is in flight. Bounded by the caller's deadline. */
function awaitInFlight(): Promise<void> {
  if (inFlight === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    idleWaiters.add(resolve);
  });
}

/**
 * Run `work`, giving up after `ms`. Resolves `true` when it finished in time
 * and `false` when it did not — a shutdown step that overran is reported, not
 * thrown, because the remaining steps still have to run.
 */
function withDeadline(work: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    work.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true);
      },
    );
  });
}

export interface ShutdownOptions {
  /** Total budget for the whole sequence. Defaults to `SHUTDOWN_GRACE_MS`. */
  graceMs?: number;
  /** Stop every poller. Defaults to the in-process poller registry. */
  stopPollers?: () => void | Promise<void>;
  /** Close the config-store pool. Defaults to the shared `pg` pool. */
  closePool?: () => Promise<void>;
  /** Where the one-line progress report goes. Defaults to `console.warn`. */
  log?: (message: string) => void;
}

async function defaultStopPollers(): Promise<void> {
  const { stopAllPollers } = await import("@/lib/poller/registry");
  stopAllPollers();
}

async function defaultClosePool(): Promise<void> {
  const { closePool } = await import("@/lib/db/pg");
  await closePool();
}

/**
 * Drain and stop. Returns the exit code (always 0) and never rejects; calling
 * it twice returns the first call's promise, so a second signal cannot start
 * a second drain.
 */
export function shutdown(opts: ShutdownOptions = {}): Promise<number> {
  shuttingDown ??= runShutdown(opts);
  return shuttingDown;
}

/** True once a shutdown has been started. */
export function isShuttingDown(): boolean {
  return shuttingDown !== null;
}

async function runShutdown(opts: ShutdownOptions): Promise<number> {
  const graceMs = opts.graceMs ?? config.shutdownGraceMs;
  const log = opts.log ?? ((message: string) => console.warn(message));
  const startedAt = Date.now();

  // The flag first and synchronously: every probe from here on must fail,
  // including one already being served.
  beginDrain();

  const completed = await withDeadline(
    (async () => {
      await (opts.stopPollers ?? defaultStopPollers)();

      // One slow stream must not hold up the others, and a hook that throws
      // must not abort the drain: settled, not `all`.
      const hooks = [...drainHooks];
      drainHooks.clear();
      await Promise.allSettled(hooks.map(async (hook) => hook()));

      await awaitInFlight();
      await (opts.closePool ?? defaultClosePool)();
    })(),
    graceMs,
  );

  const elapsed = Date.now() - startedAt;
  log(
    completed
      ? `shutdown: drained in ${elapsed}ms`
      : `shutdown: grace period of ${graceMs}ms expired with ${inFlight} query/queries in flight; exiting anyway`,
  );
  return 0;
}

/**
 * Install the `SIGTERM`/`SIGINT` handlers. Called once from
 * `src/instrumentation.ts`, after the startup checks pass.
 */
export function installSignalHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      // A second signal is an operator asking for the wait to stop. The first
      // one has already closed the streams and stopped the pollers.
      if (isShuttingDown()) {
        console.warn(`shutdown: ${signal} received while draining; exiting now`);
        process.exit(0);
      }
      console.warn(`shutdown: ${signal} received; draining`);
      void shutdown().then((code) => process.exit(code));
    });
  }
}

/**
 * Reset every module-level flag. Test-only: a real process drains once and
 * exits, so nothing in `src/` may call this.
 */
export function resetDrainForTests(): void {
  draining = false;
  inFlight = 0;
  idleWaiters.clear();
  drainHooks.clear();
  shuttingDown = null;
  handlersInstalled = false;
}
