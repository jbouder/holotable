/**
 * Drain flag.
 *
 * A process that has been asked to stop keeps serving the requests already in
 * flight but should stop being sent new ones. `/api/ready` reads this flag and
 * fails while it is set, which is what takes the instance out of a load
 * balancer before the process actually exits.
 *
 * Only the flag lives here. Installing the `SIGTERM`/`SIGINT` handlers that
 * set it, waiting out in-flight work, and closing the pools is graceful
 * shutdown (#47); this module is the part readiness needs and nothing more.
 */

let draining = false;

/** Mark the process as draining. Idempotent; there is no way back. */
export function beginDrain(): void {
  draining = true;
}

export function isDraining(): boolean {
  return draining;
}

/**
 * Clear the flag. Test-only: a real process never stops draining, so nothing
 * in `src/` may call this.
 */
export function resetDrainForTests(): void {
  draining = false;
}
