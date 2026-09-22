import { test } from "node:test";
import assert from "node:assert/strict";
import type { Dashboard } from "../src/lib/ir";
import {
  clearDraft,
  DRAFT_KEY_PREFIX,
  DRAFT_MAX_BYTES,
  DRAFT_TTL_MS,
  draftChanges,
  draftKey,
  draftOffer,
  type DraftStorage,
  pruneDrafts,
  readDraft,
  summarizeDraftChanges,
  writeDraft,
} from "../src/lib/editor/drafts";

/**
 * Draft autosave (#118).
 *
 * The storage is injected, so the rules that keep a draft from doing harm —
 * never overwriting another author's save, never trusting what it read back,
 * never growing without bound — are tested without a browser.
 */

class FakeStorage implements DraftStorage {
  readonly map = new Map<string, string>();
  /** Set to make every write throw, as a browser with storage disabled does. */
  failWrites = false;
  /** Set to make every read throw, as a privacy mode does. */
  failReads = false;

  getItem(key: string): string | null {
    if (this.failReads) throw new Error("storage disabled");
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error("QuotaExceededError");
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
}

const NOW = 1_700_000_000_000;

function spec(patch: Partial<Dashboard> = {}): Dashboard {
  return {
    title: "Ops",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 30_000,
    panels: [
      {
        id: "p1",
        title: "Requests",
        viz: "line",
        query: { sourceId: "src", sql: "SELECT 1 AS value" },
        layout: { x: 0, y: 0, w: 6, h: 4 },
      },
    ],
    ...patch,
  };
}

function envelope(
  over: Partial<{ baseVersion: number; savedAt: number; spec: Dashboard }> = {},
) {
  return {
    dashboardId: "dash-1",
    baseVersion: 3,
    savedAt: NOW - 60_000,
    spec: spec({ title: "Ops v2" }),
    ...over,
  };
}

test("a draft round-trips, and the key is per dashboard and per user", () => {
  const storage = new FakeStorage();
  const mine = draftKey("dash-1", "user-a");
  const theirs = draftKey("dash-1", "user-b");
  assert.notEqual(mine, theirs);
  assert.ok(mine.startsWith(DRAFT_KEY_PREFIX));

  assert.equal(writeDraft(storage, mine, envelope()), true);
  assert.deepEqual(readDraft(storage, mine), envelope());
  assert.equal(readDraft(storage, theirs), null);
});

test("what comes back out of storage is parsed, never trusted", () => {
  const storage = new FakeStorage();
  const key = draftKey("dash-1", "user-a");

  storage.setItem(key, "{not json");
  assert.equal(readDraft(storage, key), null);
  assert.equal(storage.getItem(key), null, "unreadable draft is cleared");

  // A structurally valid envelope whose spec is not a valid dashboard.
  storage.setItem(
    key,
    JSON.stringify({ ...envelope(), spec: { title: "Ops", panels: "everything" } }),
  );
  assert.equal(readDraft(storage, key), null);

  // Extra fields are refused too: the envelope is strict.
  storage.setItem(key, JSON.stringify({ ...envelope(), serverSecret: "x" }));
  assert.equal(readDraft(storage, key), null);
});

test("storage that is missing or refuses is survivable", () => {
  const key = draftKey("dash-1", "user-a");
  assert.equal(readDraft(null, key), null);
  assert.equal(writeDraft(null, key, envelope()), false);
  clearDraft(null, key);

  const storage = new FakeStorage();
  storage.failWrites = true;
  assert.equal(writeDraft(storage, key, envelope()), false);

  storage.failWrites = false;
  storage.failReads = true;
  assert.equal(readDraft(storage, key), null);
});

test("a draft too large to be a convenience is refused rather than stored", () => {
  const storage = new FakeStorage();
  const key = draftKey("dash-1", "user-a");
  const huge = envelope({
    spec: spec({
      panels: Array.from({ length: 50 }, (_unused, i) => ({
        id: `p${i}`,
        title: "Requests",
        viz: "line" as const,
        query: { sourceId: "src", sql: `SELECT ${"x".repeat(7_000)} AS value` },
        layout: { x: 0, y: 0, w: 6, h: 4 },
      })),
    }),
  });
  assert.ok(JSON.stringify(huge).length > DRAFT_MAX_BYTES);
  assert.equal(writeDraft(storage, key, huge), false);
  assert.equal(storage.length, 0);
});

test("pruning clears expired and unreadable drafts across every dashboard", () => {
  const storage = new FakeStorage();
  const fresh = draftKey("dash-1", "user-a");
  const stale = draftKey("dash-2", "user-a");
  const junk = draftKey("dash-3", "user-a");
  writeDraft(storage, fresh, envelope({ savedAt: NOW - 1_000 }));
  writeDraft(storage, stale, envelope({ savedAt: NOW - DRAFT_TTL_MS - 1 }));
  storage.setItem(junk, "{");
  storage.setItem("unrelated", "keep me");

  assert.equal(pruneDrafts(storage, NOW), 2);
  assert.ok(storage.getItem(fresh));
  assert.equal(storage.getItem(stale), null);
  assert.equal(storage.getItem(junk), null);
  assert.equal(storage.getItem("unrelated"), "keep me");
});

test("a draft that continues the open version is offered for restore", () => {
  const offer = draftOffer({
    draft: envelope({ baseVersion: 3 }),
    dashboardId: "dash-1",
    currentVersion: 3,
    savedSpec: spec(),
    now: NOW,
  });
  assert.equal(offer.kind, "restorable");
});

test("a draft whose base version is stale is a conflict, never an overwrite", () => {
  const offer = draftOffer({
    draft: envelope({ baseVersion: 3 }),
    dashboardId: "dash-1",
    currentVersion: 5,
    savedSpec: spec({ title: "Someone else's save" }),
    now: NOW,
  });
  assert.equal(offer.kind, "conflict");
  assert.equal(offer.kind === "conflict" && offer.draft.baseVersion, 3);
});

test("a draft with nothing to say is discarded silently", () => {
  const cases: Array<[string, Parameters<typeof draftOffer>[0]]> = [
    [
      "no draft at all",
      {
        draft: null,
        dashboardId: "dash-1",
        currentVersion: 3,
        savedSpec: spec(),
        now: NOW,
      },
    ],
    [
      "another dashboard",
      {
        draft: envelope(),
        dashboardId: "dash-9",
        currentVersion: 3,
        savedSpec: spec(),
        now: NOW,
      },
    ],
    [
      "expired",
      {
        draft: envelope({ savedAt: NOW - DRAFT_TTL_MS - 1 }),
        dashboardId: "dash-1",
        currentVersion: 3,
        savedSpec: spec(),
        now: NOW,
      },
    ],
    [
      "a base version this app cannot have written",
      {
        draft: envelope({ baseVersion: 9 }),
        dashboardId: "dash-1",
        currentVersion: 3,
        savedSpec: spec(),
        now: NOW,
      },
    ],
    [
      "identical to what is already on screen",
      {
        draft: envelope({ spec: spec() }),
        dashboardId: "dash-1",
        currentVersion: 3,
        savedSpec: spec(),
        now: NOW,
      },
    ],
  ];
  for (const [why, input] of cases) {
    assert.equal(draftOffer(input).kind, "none", why);
  }
});

test("the restore offer says what it would change", () => {
  const saved = spec();
  const draft = spec({
    title: "Ops v2",
    refreshIntervalMs: 60_000,
    panels: [
      { ...saved.panels[0], title: "Requests per second" },
      {
        id: "p2",
        title: "Errors",
        viz: "bar",
        query: { sourceId: "src", sql: "SELECT 2 AS value" },
        layout: { x: 6, y: 0, w: 6, h: 4 },
      },
    ],
  });
  const changes = draftChanges(saved, draft);
  assert.deepEqual(changes.added, ["Errors"]);
  assert.deepEqual(changes.changed, ["Requests per second"]);
  assert.deepEqual(changes.removed, []);
  assert.equal(changes.title, true);
  assert.equal(changes.refresh, true);
  assert.equal(changes.timeRange, false);
  assert.equal(
    summarizeDraftChanges(changes),
    "1 panel added, 1 panel edited, title changed, refresh changed",
  );
  assert.equal(summarizeDraftChanges(draftChanges(saved, saved)), null);
});

test("a removed panel is reported by the title it had", () => {
  const saved = spec({
    panels: [
      spec().panels[0],
      {
        id: "p2",
        title: "Errors",
        viz: "bar",
        query: { sourceId: "src", sql: "SELECT 2 AS value" },
        layout: { x: 6, y: 0, w: 6, h: 4 },
      },
    ],
  });
  const changes = draftChanges(saved, spec());
  assert.deepEqual(changes.removed, ["Errors"]);
  assert.equal(summarizeDraftChanges(changes), "1 panel removed");
});
