import { test } from "node:test";
import assert from "node:assert/strict";
import type { BrowserStorage } from "../src/lib/browser-storage";
import {
  clearPromptHistory,
  PROMPT_HISTORY_MAX,
  PROMPT_HISTORY_PREFIX,
  PROMPT_HISTORY_TTL_MS,
  PROMPT_MAX_LENGTH,
  promptHistoryKey,
  promptLabel,
  prunePromptHistory,
  readPromptHistory,
  rememberPrompt,
  withPrompt,
} from "../src/lib/prompt-history";

/**
 * Recent prompts (#83).
 *
 * The storage is injected, so the rules that keep the list useful and bounded
 * — dedupe, cap, expiry, and refusing to trust what came back out — are tested
 * without a browser.
 */

class FakeStorage implements BrowserStorage {
  readonly map = new Map<string, string>();
  failWrites = false;
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
const KEY = promptHistoryKey("ws-1", "dashboard");

test("a list is scoped to one workspace and one box", () => {
  assert.notEqual(
    promptHistoryKey("ws-1", "dashboard"),
    promptHistoryKey("ws-2", "dashboard"),
  );
  assert.notEqual(
    promptHistoryKey("ws-1", "dashboard"),
    promptHistoryKey("ws-1", "panel"),
  );
  assert.ok(KEY.startsWith(PROMPT_HISTORY_PREFIX));
});

test("a remembered prompt comes back, newest first", () => {
  const storage = new FakeStorage();
  rememberPrompt(storage, KEY, "p95 latency by route", NOW);
  rememberPrompt(storage, KEY, "error rate over time", NOW + 1000);
  assert.deepEqual(
    readPromptHistory(storage, KEY, NOW + 2000).map((e) => e.prompt),
    ["error rate over time", "p95 latency by route"],
  );
});

test("one workspace's prompts are not offered in another", () => {
  const storage = new FakeStorage();
  rememberPrompt(storage, promptHistoryKey("ws-1", "dashboard"), "ours", NOW);
  assert.deepEqual(
    readPromptHistory(storage, promptHistoryKey("ws-2", "dashboard"), NOW),
    [],
  );
});

test("the same prompt again moves to the front rather than appearing twice", () => {
  const storage = new FakeStorage();
  rememberPrompt(storage, KEY, "a", NOW);
  rememberPrompt(storage, KEY, "b", NOW + 1);
  rememberPrompt(storage, KEY, "a  ", NOW + 2);
  assert.deepEqual(
    readPromptHistory(storage, KEY, NOW + 3).map((e) => e.prompt),
    ["a", "b"],
  );
});

test("an empty or whitespace prompt is not remembered", () => {
  assert.deepEqual(withPrompt([], "   \n ", NOW), []);
  assert.deepEqual(withPrompt([], "", NOW), []);
});

test("the list is capped", () => {
  const storage = new FakeStorage();
  for (let i = 0; i < PROMPT_HISTORY_MAX + 10; i++) {
    rememberPrompt(storage, KEY, `prompt ${i}`, NOW + i);
  }
  const entries = readPromptHistory(storage, KEY, NOW + 1000);
  assert.equal(entries.length, PROMPT_HISTORY_MAX);
  // The newest survive; the oldest are the ones dropped.
  assert.equal(entries[0]?.prompt, `prompt ${PROMPT_HISTORY_MAX + 9}`);
});

test("a prompt longer than the route accepts is stored clipped", () => {
  const stored = withPrompt([], "x".repeat(PROMPT_MAX_LENGTH + 100), NOW);
  assert.equal(stored[0]?.prompt.length, PROMPT_MAX_LENGTH);
});

test("an entry past the window is not offered back", () => {
  const storage = new FakeStorage();
  rememberPrompt(storage, KEY, "ancient", NOW);
  rememberPrompt(storage, KEY, "recent", NOW + PROMPT_HISTORY_TTL_MS);
  assert.deepEqual(
    readPromptHistory(storage, KEY, NOW + PROMPT_HISTORY_TTL_MS + 1).map((e) => e.prompt),
    ["recent"],
  );
});

/* -------------------------------------------------------------------------- */
/* What comes back out is not trusted                                         */
/* -------------------------------------------------------------------------- */

test("a value that is not a list of entries is discarded, not rendered", () => {
  const storage = new FakeStorage();
  for (const raw of ['{"not":"an array"}', "not json at all", "[1,2,3]"]) {
    storage.map.set(KEY, raw);
    assert.deepEqual(readPromptHistory(storage, KEY, NOW), []);
  }
});

test("entries of the wrong shape are dropped one by one", () => {
  const storage = new FakeStorage();
  storage.map.set(
    KEY,
    JSON.stringify([
      { prompt: "good", at: NOW },
      { prompt: "", at: NOW },
      { prompt: 42, at: NOW },
      { prompt: "no timestamp" },
      null,
    ]),
  );
  assert.deepEqual(
    readPromptHistory(storage, KEY, NOW).map((e) => e.prompt),
    ["good"],
  );
});

test("storage that throws is survivable in both directions", () => {
  const reads = new FakeStorage();
  reads.failReads = true;
  assert.deepEqual(readPromptHistory(reads, KEY, NOW), []);

  const writes = new FakeStorage();
  writes.failWrites = true;
  // The write is refused, but the caller still gets the list it asked for, so
  // the dropdown works for this session even in a browser that stores nothing.
  assert.deepEqual(
    rememberPrompt(writes, KEY, "still usable", NOW).map((e) => e.prompt),
    ["still usable"],
  );

  assert.deepEqual(readPromptHistory(null, KEY, NOW), []);
  assert.deepEqual(
    rememberPrompt(null, KEY, "x", NOW).map((e) => e.prompt),
    ["x"],
  );
});

/* -------------------------------------------------------------------------- */
/* Bounded across workspaces                                                  */
/* -------------------------------------------------------------------------- */

test("pruning drops lists that have nothing left to offer", () => {
  const storage = new FakeStorage();
  rememberPrompt(storage, promptHistoryKey("ws-old", "dashboard"), "ancient", NOW);
  rememberPrompt(
    storage,
    promptHistoryKey("ws-new", "dashboard"),
    "recent",
    NOW + PROMPT_HISTORY_TTL_MS,
  );
  storage.map.set("unrelated-key", "left alone");

  const dropped = prunePromptHistory(storage, NOW + PROMPT_HISTORY_TTL_MS + 1);
  assert.equal(dropped, 1);
  assert.equal(storage.map.has(promptHistoryKey("ws-old", "dashboard")), false);
  assert.equal(storage.map.has(promptHistoryKey("ws-new", "dashboard")), true);
  assert.equal(storage.map.get("unrelated-key"), "left alone");
});

test("clearing forgets one list and leaves the others", () => {
  const storage = new FakeStorage();
  rememberPrompt(storage, promptHistoryKey("ws-1", "dashboard"), "a", NOW);
  rememberPrompt(storage, promptHistoryKey("ws-2", "dashboard"), "b", NOW);
  clearPromptHistory(storage, promptHistoryKey("ws-1", "dashboard"));
  assert.deepEqual(
    readPromptHistory(storage, promptHistoryKey("ws-1", "dashboard"), NOW),
    [],
  );
  assert.equal(
    readPromptHistory(storage, promptHistoryKey("ws-2", "dashboard"), NOW).length,
    1,
  );
});

/* -------------------------------------------------------------------------- */
/* Presentation                                                               */
/* -------------------------------------------------------------------------- */

test("a prompt reads as one line in the dropdown", () => {
  assert.equal(promptLabel("  p95   latency\nby route  "), "p95 latency by route");
  const long = promptLabel("x".repeat(200));
  assert.equal(long.length, 80);
  assert.ok(long.endsWith("…"));
});
