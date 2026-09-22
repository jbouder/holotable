import { test } from "node:test";
import assert from "node:assert/strict";
import {
  connectionAnnouncement,
  connectionLabel,
  connectionTone,
  type ConnectionStatus,
  formatAge,
  formatClockTime,
  INITIAL_CONNECTION,
  MANUAL_RECONNECT_AFTER_ATTEMPTS,
  reduceConnection,
  shouldOfferReconnect,
} from "@/lib/connection";

function after(
  start: ConnectionStatus,
  ...signals: Parameters<typeof reduceConnection>[1][]
): ConnectionStatus {
  return signals.reduce(reduceConnection, start);
}

test("starts connecting with nothing to report", () => {
  assert.equal(INITIAL_CONNECTION.state, "connecting");
  assert.equal(INITIAL_CONNECTION.lastEventAt, undefined);
  assert.equal(formatAge(INITIAL_CONNECTION.lastEventAt, 1_000), "no data yet");
});

test("a dropped stream is distinguishable from a paused one", () => {
  const paused = after(INITIAL_CONNECTION, { type: "open" }, { type: "pause" });
  const dropped = after(
    INITIAL_CONNECTION,
    { type: "open" },
    {
      type: "error",
      closed: false,
    },
  );
  const dead = after(
    INITIAL_CONNECTION,
    { type: "open" },
    { type: "error", closed: true },
  );

  assert.equal(paused.state, "paused");
  assert.equal(dropped.state, "reconnecting");
  assert.equal(dead.state, "failed");
  // The three must not collapse to the same readout — that conflation is the
  // bug this indicator exists to fix.
  const labels = new Set([paused, dropped, dead].map(connectionLabel));
  assert.equal(labels.size, 3);
  const tones = new Set([paused, dropped, dead].map((s) => connectionTone(s.state)));
  assert.equal(tones.size, 3);
});

test("reconnect attempts accumulate and are named", () => {
  let status = after(INITIAL_CONNECTION, { type: "open" });
  assert.equal(status.attempt, 0);
  for (let i = 1; i <= 3; i++) {
    status = reduceConnection(status, { type: "error", closed: false });
    assert.equal(status.attempt, i);
  }
  assert.equal(connectionLabel(status), "Reconnecting, attempt 3");
  // The first failure reads as plain "Reconnecting" — an "attempt 1" counter
  // is noise on the retry that usually succeeds.
  const first = after(INITIAL_CONNECTION, { type: "error", closed: false });
  assert.equal(connectionLabel(first), "Reconnecting");
});

test("a successful open clears the attempt counter", () => {
  const status = after(
    INITIAL_CONNECTION,
    { type: "error", closed: false },
    { type: "error", closed: false },
    { type: "open" },
  );
  assert.equal(status.state, "live");
  assert.equal(status.attempt, 0);
});

test("reopening the socket does not make stale data look fresh", () => {
  const status = after(
    INITIAL_CONNECTION,
    { type: "tick", at: 1_000 },
    { type: "error", closed: false },
    { type: "open" },
  );
  // The socket is back; no data has arrived on it yet, so the age still counts
  // from the last tick.
  assert.equal(status.lastEventAt, 1_000);
  assert.equal(
    formatAge(status.lastEventAt, 91_000),
    `updated at ${formatClockTime(1_000)}`,
  );
});

test("a manual reconnect is offered only once the retries are not working", () => {
  let status = after(INITIAL_CONNECTION, { type: "open" });
  assert.equal(shouldOfferReconnect(status), false);
  for (let i = 0; i < MANUAL_RECONNECT_AFTER_ATTEMPTS - 1; i++) {
    status = reduceConnection(status, { type: "error", closed: false });
    assert.equal(shouldOfferReconnect(status), false, `after ${i + 1}`);
  }
  status = reduceConnection(status, { type: "error", closed: false });
  assert.equal(shouldOfferReconnect(status), true);
});

test("a definitively closed stream offers a reconnect immediately", () => {
  const status = after(INITIAL_CONNECTION, { type: "error", closed: true });
  assert.equal(status.state, "failed");
  assert.equal(shouldOfferReconnect(status), true);
});

test("a paused stream never offers a reconnect", () => {
  const status = after(INITIAL_CONNECTION, { type: "open" }, { type: "pause" });
  assert.equal(shouldOfferReconnect(status), false);
});

test("resuming goes back through connecting, not straight to live", () => {
  const status = after(
    INITIAL_CONNECTION,
    { type: "tick", at: 500 },
    { type: "pause" },
    { type: "resume" },
  );
  assert.equal(status.state, "connecting");
  assert.equal(status.lastEventAt, 500);
});

test("a tick means live, whatever the previous state was", () => {
  const status = after(
    INITIAL_CONNECTION,
    { type: "error", closed: true },
    { type: "tick", at: 7_000 },
  );
  assert.equal(status.state, "live");
  assert.equal(status.attempt, 0);
  assert.equal(status.lastEventAt, 7_000);
});

test("age is relative for the first minute and absolute after", () => {
  const at = Date.parse("2026-09-22T12:34:56.000Z");
  assert.equal(formatAge(at, at), "updated just now");
  assert.equal(formatAge(at, at + 4_999), "updated just now");
  assert.equal(formatAge(at, at + 5_000), "updated 5s ago");
  assert.equal(formatAge(at, at + 42_400), "updated 42s ago");
  assert.equal(formatAge(at, at + 59_999), "updated 59s ago");
  assert.equal(formatAge(at, at + 60_000), `updated at ${formatClockTime(at)}`);
  assert.equal(formatAge(at, at + 86_400_000), `updated at ${formatClockTime(at)}`);
});

test("clock times are zero-padded", () => {
  const at = new Date(2026, 8, 22, 4, 5, 6).getTime();
  assert.equal(formatClockTime(at), "04:05:06");
});

test("the announcement carries the state and the age in one sentence", () => {
  const status = after(
    INITIAL_CONNECTION,
    { type: "tick", at: 1_000 },
    { type: "error", closed: false },
    { type: "error", closed: false },
  );
  assert.equal(
    connectionAnnouncement(status, 11_000),
    "Reconnecting, attempt 2. updated 10s ago.",
  );
});
