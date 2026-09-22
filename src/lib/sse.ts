/**
 * Server-Sent Events framing shared by the dashboard stream.
 *
 * Only the shutdown frame lives here. The poller's own events are serialized
 * inline by the route; this one has a policy attached to it and a test, so it
 * is worth a module of its own.
 */

/** Named so a client can react without it looking like a poller event. */
export const DRAIN_EVENT = "draining";

/**
 * Reconnect delay handed to the browser when the server drains, in
 * milliseconds. `EventSource` honours the SSE `retry:` field natively, so the
 * terminating instance is what decides when its subscribers come back.
 *
 * Spread on purpose: every stream on the instance is closed in the same tick,
 * and a fixed delay would send all of them back at the same moment — at the
 * replacement instance, which is the one least able to absorb it.
 */
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_SPREAD_MS = 8_000;

/**
 * The terminal frame: a reconnect hint plus one named event, so a viewer can
 * show the gap instead of waiting for the staleness watchdog to notice.
 *
 * `random` is injectable for the test; production passes nothing.
 */
export function drainFrame(random: () => number = Math.random): string {
  const retryMs = RECONNECT_BASE_MS + Math.floor(random() * RECONNECT_SPREAD_MS);
  return `retry: ${retryMs}\nevent: ${DRAIN_EVENT}\ndata: {"reason":"shutdown"}\n\n`;
}
