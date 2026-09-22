import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canRedo,
  canUndo,
  COALESCE_WINDOW_MS,
  type History,
  initHistory,
  pushHistory,
  redoAction,
  redoHistory,
  undoAction,
  undoHistory,
} from "../src/lib/editor/use-history";

/**
 * Editor undo/redo (#81).
 *
 * The hook is a wrapper; every rule worth pinning lives in the reducer, which
 * takes `now` as an argument rather than reading a clock, so the coalescing
 * window is testable without timers.
 */

const t0 = 1_000_000;

function push(h: History<string>, value: string, at: number, key?: string | null) {
  return pushHistory(h, value, { action: `set ${value}`, key: key ?? null, at });
}

test("the initial state is present with nothing to undo or redo", () => {
  const h = initHistory("a");
  assert.equal(h.present.value, "a");
  assert.equal(canUndo(h), false);
  assert.equal(canRedo(h), false);
  assert.equal(undoAction(h), null);
  assert.equal(redoAction(h), null);
});

test("undo walks back and redo walks forward through distinct entries", () => {
  let h = initHistory("a");
  h = push(h, "b", t0);
  h = push(h, "c", t0 + 5_000);
  assert.equal(h.present.value, "c");

  h = undoHistory(h);
  assert.equal(h.present.value, "b");
  h = undoHistory(h);
  assert.equal(h.present.value, "a");
  assert.equal(canUndo(h), false);

  h = redoHistory(h);
  assert.equal(h.present.value, "b");
  h = redoHistory(h);
  assert.equal(h.present.value, "c");
  assert.equal(canRedo(h), false);
});

test("undoing past the start and redoing past the end are no-ops", () => {
  const h = initHistory("a");
  assert.equal(undoHistory(h), h);
  assert.equal(redoHistory(h), h);
});

test("a burst of edits to one field coalesces into a single entry", () => {
  let h = initHistory("");
  for (const [i, value] of ["c", "cp", "cpu", "cpu%"].entries()) {
    h = push(h, value, t0 + i * 50, "title");
  }
  assert.equal(h.present.value, "cpu%");
  // One entry behind the present: the state the editor opened with.
  assert.equal(h.past.length, 1);
  h = undoHistory(h);
  assert.equal(h.present.value, "");
});

test("a pause longer than the window starts a new entry", () => {
  let h = initHistory("");
  h = push(h, "cpu", t0, "title");
  h = push(h, "cpu load", t0 + COALESCE_WINDOW_MS + 1, "title");
  assert.equal(h.past.length, 2);
  assert.equal(undoHistory(h).present.value, "cpu");
});

test("a different field never coalesces into the previous one", () => {
  let h = initHistory("");
  h = push(h, "cpu", t0, "title");
  h = push(h, "cpu+sql", t0 + 10, "sql");
  assert.equal(h.past.length, 2);
  assert.equal(undoHistory(h).present.value, "cpu");
});

test("an unkeyed action always stands alone, even back to back", () => {
  let h = initHistory("a");
  h = push(h, "b", t0);
  h = push(h, "c", t0 + 1);
  assert.equal(h.past.length, 2);
});

test("continuous typing cannot extend the window indefinitely", () => {
  // Each keystroke lands inside the window relative to the previous one, but
  // the merged entry keeps the first timestamp, so the burst ends on schedule.
  let h = initHistory("");
  let at = t0;
  for (let i = 0; i < 20; i++) {
    at += 200;
    h = push(h, `v${i}`, at, "title");
  }
  assert.ok(h.past.length >= 4, `expected the burst to break up, got ${h.past.length}`);
});

test("a new action after an undo clears the redo branch", () => {
  let h = initHistory("a");
  h = push(h, "b", t0);
  h = push(h, "c", t0 + 5_000);
  h = undoHistory(h);
  assert.equal(canRedo(h), true);
  h = push(h, "d", t0 + 10_000);
  assert.equal(canRedo(h), false);
  assert.equal(h.present.value, "d");
  assert.equal(undoHistory(h).present.value, "b");
});

test("the past is bounded and drops the oldest entry first", () => {
  let h = initHistory("start");
  for (let i = 0; i < 25; i++) {
    h = pushHistory(h, `v${i}`, { action: `set v${i}`, at: t0 + i * 5_000, limit: 5 });
  }
  assert.equal(h.past.length, 5);
  assert.equal(h.past[0].value, "v19");
  assert.equal(h.present.value, "v24");
});

test("the action labels name what undo and redo would do", () => {
  let h = initHistory("a");
  h = pushHistory(h, "b", { action: "delete panel", at: t0 });
  assert.equal(undoAction(h), "delete panel");
  assert.equal(redoAction(h), null);
  h = undoHistory(h);
  assert.equal(redoAction(h), "delete panel");
});
