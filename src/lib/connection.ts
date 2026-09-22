/**
 * Connection and freshness state for the live dashboard stream.
 *
 * `EventSource` reconnects forever and says nothing about it, so a dead stream
 * and a slow one look identical — and both looked like "Live" in the viewer.
 * The state machine here is the difference between "paused deliberately",
 * "trying to get back", and "gave up", and it is pure so it can be tested
 * without a socket.
 *
 * Kept out of the component on purpose: the viewer owns the `EventSource`, this
 * owns what its callbacks mean.
 */

export type ConnectionState =
  | "connecting"
  | "live"
  | "reconnecting"
  | "paused"
  | "failed";

export interface ConnectionStatus {
  state: ConnectionState;
  /** Consecutive failed attempts since the last successful open. */
  attempt: number;
  /** When data last arrived, from the server's `tick`. Undefined before the first. */
  lastEventAt?: number;
}

/**
 * A transport event, normalized. `closed` distinguishes the two things
 * `EventSource.onerror` means: `readyState === CLOSED` is final (the browser
 * will not retry — a 4xx on the stream route, typically an expired session),
 * anything else is a retry already in flight.
 */
export type ConnectionSignal =
  | { type: "open" }
  | { type: "error"; closed: boolean }
  | { type: "tick"; at: number }
  | { type: "pause" }
  | { type: "resume" };

export const INITIAL_CONNECTION: ConnectionStatus = { state: "connecting", attempt: 0 };

/**
 * How many consecutive failures before the automatic retries are treated as
 * not working and a manual Reconnect is offered. `EventSource` backs off on
 * its own schedule, which the page cannot read, so this counts attempts rather
 * than waiting a wall-clock interval.
 */
export const MANUAL_RECONNECT_AFTER_ATTEMPTS = 3;

export function reduceConnection(
  prev: ConnectionStatus,
  signal: ConnectionSignal,
): ConnectionStatus {
  switch (signal.type) {
    case "open":
      // The socket is up but nothing has arrived yet, so `lastEventAt` is left
      // alone: it answers "how old is this number", not "how old is this
      // socket". A reconnect must not make stale data look fresh.
      return { ...prev, state: "live", attempt: 0 };
    case "error":
      return {
        ...prev,
        state: signal.closed ? "failed" : "reconnecting",
        attempt: prev.attempt + 1,
      };
    case "tick":
      return { state: "live", attempt: 0, lastEventAt: signal.at };
    case "pause":
      return { ...prev, state: "paused", attempt: 0 };
    case "resume":
      return { ...prev, state: "connecting", attempt: 0 };
  }
}

/** Whether to show a manual Reconnect alongside the indicator. */
export function shouldOfferReconnect(status: ConnectionStatus): boolean {
  if (status.state === "failed") return true;
  return (
    status.state === "reconnecting" && status.attempt >= MANUAL_RECONNECT_AFTER_ATTEMPTS
  );
}

/** The word shown in the indicator. */
export function connectionLabel(status: ConnectionStatus): string {
  switch (status.state) {
    case "connecting":
      return "Connecting";
    case "live":
      return "Live";
    case "reconnecting":
      return status.attempt > 1
        ? `Reconnecting, attempt ${status.attempt}`
        : "Reconnecting";
    case "paused":
      return "Paused";
    case "failed":
      return "Disconnected";
  }
}

export type ConnectionTone = "live" | "muted" | "warning" | "danger";

/**
 * Paused is deliberately `muted` and failed is `danger` — the two states the
 * old single dot conflated.
 */
export function connectionTone(state: ConnectionState): ConnectionTone {
  switch (state) {
    case "live":
      return "live";
    case "connecting":
    case "reconnecting":
      return "warning";
    case "failed":
      return "danger";
    case "paused":
      return "muted";
  }
}

const JUST_NOW_MS = 5_000;
const RELATIVE_LIMIT_MS = 60_000;

/**
 * "how old is this number", in words.
 *
 * Relative for the first minute, where the number is changing and the user is
 * watching it; absolute past that, where "127s ago" is arithmetic nobody wants
 * to do and a clock time is what they would compare against.
 */
export function formatAge(lastEventAt: number | undefined, now: number): string {
  if (lastEventAt === undefined) return "no data yet";
  const age = now - lastEventAt;
  if (age < JUST_NOW_MS) return "updated just now";
  if (age < RELATIVE_LIMIT_MS) return `updated ${Math.floor(age / 1000)}s ago`;
  return `updated at ${formatClockTime(lastEventAt)}`;
}

/** Local wall-clock time, zero-padded. Stable across locales, unlike `toLocaleTimeString`. */
export function formatClockTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * The full sentence a screen reader is handed when the state changes. The
 * indicator is an `aria-live` region, so this is what actually gets announced.
 */
export function connectionAnnouncement(status: ConnectionStatus, now: number): string {
  return `${connectionLabel(status)}. ${formatAge(status.lastEventAt, now)}.`;
}
