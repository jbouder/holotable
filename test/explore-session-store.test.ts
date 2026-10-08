import { test } from "node:test";
import assert from "node:assert/strict";
import type { QueryPanel } from "@/lib/ir";
import { EMPTY_TABLE_VIEW, initialView } from "@/lib/explore-view";
import {
  EXPLORE_SESSION_KEY,
  parseStoredSession,
  readStoredSession,
  serializeSession,
  type StoredEntry,
  writeStoredSession,
} from "@/lib/explore-session-store";

const panel: QueryPanel = {
  id: "explore",
  title: "Requests",
  viz: "line",
  query: { sourceId: "s", sql: "SELECT ts, v FROM m", timeField: "ts" },
  layout: { x: 0, y: 0, w: 6, h: 4 },
};

const entry = (prompt: string, overrides: Partial<StoredEntry> = {}): StoredEntry => ({
  prompt,
  askedAt: 1_700_000_000_000,
  sourceName: "Metrics",
  workspaceId: "demo",
  from: "now-1h",
  panel,
  view: { ...initialView(panel), viz: "bar", stacked: true },
  table: EMPTY_TABLE_VIEW,
  ...overrides,
});

function memory(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  };
}

test("a kept session comes back for the same person, with its views and no rows", () => {
  const kept = { entries: [entry("b"), entry("a")], activeIndex: 1, pinnedIndex: 0 };
  const raw = serializeSession("u1", kept);
  assert.ok(!raw.includes("rows"), "rows are never kept");
  assert.deepEqual(parseStoredSession(raw, "u1"), kept);
});

test("someone else's session, garbage, or nothing is not restored", () => {
  const raw = serializeSession("u1", {
    entries: [entry("a")],
    activeIndex: 0,
    pinnedIndex: null,
  });
  assert.equal(parseStoredSession(raw, "u2"), null);
  assert.equal(parseStoredSession("{not json", "u1"), null);
  assert.equal(parseStoredSession(JSON.stringify({ v: 2, sub: "u1" }), "u1"), null);
  assert.equal(parseStoredSession(null, "u1"), null);
});

test("an entry that is not a valid panel is dropped, and the indexes follow", () => {
  const raw = JSON.stringify({
    v: 1,
    sub: "u1",
    activeIndex: 2,
    pinnedIndex: 0,
    entries: [
      // Not an IR panel: a query-less kind, so it is not an answer.
      { ...entry("text"), panel: { ...panel, viz: "text", query: undefined } },
      entry("kept one"),
      entry("kept two"),
    ],
  });
  const restored = parseStoredSession(raw, "u1");
  assert.deepEqual(
    restored?.entries.map((e) => e.prompt),
    ["kept one", "kept two"],
  );
  assert.equal(restored?.activeIndex, 1);
  // The pinned one was dropped, so nothing is pinned.
  assert.equal(restored?.pinnedIndex, null);
});

test("a view that no longer makes a valid panel falls back to the model's", () => {
  const fixedMin = { ...panel, options: { yAxis: { min: 0 } } } as QueryPanel;
  const raw = serializeSession("u1", {
    entries: [
      entry("a", { panel: fixedMin, view: { ...initialView(fixedMin), log: true } }),
    ],
    activeIndex: 0,
    pinnedIndex: null,
  });
  assert.deepEqual(
    parseStoredSession(raw, "u1")?.entries[0]?.view,
    initialView(fixedMin),
  );
});

test("writing an empty session forgets it; storage that throws is not an error", () => {
  const storage = memory();
  writeStoredSession(storage, "u1", {
    entries: [entry("a")],
    activeIndex: 0,
    pinnedIndex: null,
  });
  assert.ok(storage.getItem(EXPLORE_SESSION_KEY));
  assert.equal(readStoredSession(storage, "u1")?.entries.length, 1);
  writeStoredSession(storage, "u1", {
    entries: [],
    activeIndex: null,
    pinnedIndex: null,
  });
  assert.equal(storage.getItem(EXPLORE_SESSION_KEY), null);

  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("quota");
    },
    removeItem: () => {
      throw new Error("denied");
    },
  };
  assert.equal(readStoredSession(broken, "u1"), null);
  writeStoredSession(broken, "u1", null);
});
