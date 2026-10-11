/**
 * Server-Sent Events framing shared by the dashboard stream.
 *
 * The poller's events, the terminal frames (shutdown, and a session that
 * ended, expired or lost access), and the heartbeat.
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

/** Named, like the drain frame, so it never looks like a poller event. */
export const SESSION_ENDED_EVENT = "session-ended";

/**
 * The frame a stream sends when the session that opened it was revoked (#28),
 * just before the server closes it. No `retry:`: the client closes the
 * EventSource itself, because a reconnect would only be refused.
 */
export function sessionEndedFrame(): string {
  return `event: ${SESSION_ENDED_EVENT}\ndata: {"reason":"revoked"}\n\n`;
}

/**
 * The session token the stream was opened with has expired (#32). Not an
 * error: the client renews (or finds its session already renewed) and opens
 * the stream again with its last event id, which resumes where this one
 * stopped. No `retry:`, for the same reason as above.
 */
export const SESSION_EXPIRED_EVENT = "session-expired";

export function sessionExpiredFrame(): string {
  return `event: ${SESSION_EXPIRED_EVENT}\ndata: {"reason":"expired"}\n\n`;
}

/**
 * The subscriber may no longer view this dashboard, or it was deleted (#32).
 * The client stops; renewing would not change the answer.
 */
export const ACCESS_ENDED_EVENT = "access-ended";

export function accessEndedFrame(): string {
  return `event: ${ACCESS_ENDED_EVENT}\ndata: {"reason":"forbidden"}\n\n`;
}

/**
 * A poller event as a frame, its `data:` line serialized once per event
 * object (#489). `id` is the resume token (#43): the browser keeps the last
 * one it saw and hands it back on reconnect. SSE ids may not contain a
 * newline; the token is base64url, and anything else is dropped rather than
 * allowed to split the frame.
 *
 * The poller hands every subscriber the same object for the same payload (a
 * delta is shared by every subscriber on the same cursor), so a tick on a
 * dashboard a hundred people watch is serialized once, not a hundred times.
 * Weakly held: an event nobody holds any more takes its bytes with it.
 */
const encoded = new WeakMap<object, Uint8Array>();
const utf8 = new TextEncoder();
let serializations = 0;

export function encodeEventFrame(event: object, id?: string): Uint8Array {
  let data = encoded.get(event);
  if (!data) {
    serializations++;
    data = utf8.encode(`data: ${JSON.stringify(event)}\n\n`);
    encoded.set(event, data);
  }
  const idLine = id && !/[\r\n\0]/.test(id) ? utf8.encode(`id: ${id}\n`) : null;
  if (!idLine) return data;
  const frame = new Uint8Array(idLine.length + data.length);
  frame.set(idLine);
  frame.set(data, idLine.length);
  return frame;
}

/** How many events have been serialized in this process. For tests. */
export function serializationCount(): number {
  return serializations;
}

/**
 * A subscriber that has not read for `SSE_SLOW_TICKS` cycles is closed
 * (#489), with a reconnect hint spread like the drain's so the dropped come
 * back apart. The client treats it as a reconnect after the delay, resuming
 * from its last event id.
 */
export const DROP_EVENT = "drop";

export function dropFrame(random: () => number = Math.random): string {
  const retryMs = RECONNECT_BASE_MS + Math.floor(random() * RECONNECT_SPREAD_MS);
  return `retry: ${retryMs}\nevent: ${DROP_EVENT}\ndata: {"reason":"slow"}\n\n`;
}

/**
 * The headers of every dashboard stream response. `no-transform` and
 * `X-Accel-Buffering: no` keep a proxy or ingress from compressing or
 * buffering it (#489), which would hold frames back until a buffer filled.
 */
export const STREAM_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

/** A comment line: ignored by `EventSource`, but traffic to a proxy. */
export const HEARTBEAT_FRAME = ": keepalive\n\n";
export const HEARTBEAT_MS = 15_000;
