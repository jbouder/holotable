import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { BrowserStorage } from "@/lib/browser-storage";
import { RECENTS_STORAGE_KEY } from "@/lib/command-palette";
import { RECENT_KEY } from "@/lib/dashboard-list";
import { DISMISSIBLE, SETUP_DISMISSED_COOKIE } from "@/lib/dismissals";
import { clearDrafts, DRAFT_KEY_PREFIX, draftKey, listDrafts } from "@/lib/editor/drafts";
import { formatBytes, formatSavedAt } from "@/lib/local-data-format";
import {
  clearAllLocalData,
  COOKIE_EXCLUSIONS,
  describeCount,
  keyMatches,
  LOCAL_COOKIES,
  LOCAL_STORAGE_EXCLUSIONS,
  LOCAL_STORES,
  storeForKey,
} from "@/lib/local-data";
import { PROMPT_HISTORY_PREFIX, promptHistoryKey } from "@/lib/prompt-history";
import { MOTION_STORAGE_KEY } from "@/lib/motion";
import { THEME_STORAGE_KEY } from "@/lib/theme";

function memory(
  initial: Record<string, string> = {},
): BrowserStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
    get length() {
      return data.size;
    },
    key: (i) => [...data.keys()][i] ?? null,
  };
}

const NOW = Date.UTC(2026, 8, 23, 12);

function envelope(
  dashboardId: string,
  savedAt = NOW - 60_000,
  title = `Dash ${dashboardId}`,
) {
  return JSON.stringify({
    dashboardId,
    baseVersion: 1,
    savedAt,
    spec: {
      title,
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
    },
  });
}

/** A browser holding a bit of everything, for two people. */
function populated() {
  return memory({
    [draftKey("d1", "alice")]: envelope("d1", NOW - 120_000, "Latency"),
    [draftKey("d2", "alice")]: envelope("d2", NOW - 60_000, "Errors"),
    [draftKey("d1", "bob")]: envelope("d1"),
    [promptHistoryKey("w1", "dashboard")]: JSON.stringify([
      { prompt: "p95 latency by service", at: NOW - 1000 },
      { prompt: "error rate", at: NOW - 2000 },
    ]),
    [promptHistoryKey("w2", "explore")]: JSON.stringify([
      { prompt: "cpu", at: NOW - 1000 },
    ]),
    [RECENT_KEY]: JSON.stringify(["d1", "d2", "d3"]),
    [RECENTS_STORAGE_KEY]: JSON.stringify(["page:explore"]),
    [THEME_STORAGE_KEY]: "light",
    [MOTION_STORAGE_KEY]: "reduce",
    "someone-elses-key": "untouched",
  });
}

const ctx = (userSub = "alice") => ({ userSub, now: NOW });
const count = (s: BrowserStorage | null, id: string, sub = "alice") =>
  LOCAL_STORES.find((x) => x.id === id)?.count(s, ctx(sub));

test("drafts are listed for the signed-in subject only, newest first", () => {
  const s = populated();
  const drafts = listDrafts(s, "alice");
  assert.deepEqual(
    drafts.map((d) => [d.dashboardId, d.title]),
    [
      ["d2", "Errors"],
      ["d1", "Latency"],
    ],
  );
  assert.ok(drafts[0].bytes > 0);
  assert.equal(listDrafts(s, "bob").length, 1);
  assert.equal(listDrafts(s, "").length, 0);
});

test("a key that only ends like the subject's is not theirs", () => {
  // Subject "x:alice" writing dashboard "d9" makes a key that ends in ":alice".
  const s = memory({ [draftKey("d9", "x:alice")]: envelope("d9") });
  assert.equal(listDrafts(s, "alice").length, 0);
  assert.equal(listDrafts(s, "x:alice").length, 1);
});

test("clearing drafts leaves other people's drafts on the same browser", () => {
  const s = populated();
  assert.equal(clearDrafts(s, "alice"), 2);
  assert.equal(listDrafts(s, "alice").length, 0);
  assert.ok(s.data.has(draftKey("d1", "bob")));
});

test("each store counts what it holds and clears only its own keys", () => {
  const s = populated();
  assert.equal(count(s, "drafts"), 2);
  assert.equal(count(s, "prompts"), 3);
  assert.equal(count(s, "recent-dashboards"), 3);
  assert.equal(count(s, "palette-recents"), 1);
  for (const store of LOCAL_STORES) {
    const before = new Map(populated().data);
    const t = populated();
    store.clear(t, ctx());
    assert.equal(store.count(t, ctx()), 0, `${store.id} not empty after clear`);
    for (const [key, value] of before) {
      if (t.data.has(key)) continue;
      const owner = storeForKey(key);
      assert.equal(
        owner?.id,
        store.id,
        `${store.id} removed ${key}, which it does not own`,
      );
      assert.ok(value);
    }
  }
});

test("clear everything empties every store and nothing else", () => {
  const s = populated();
  clearAllLocalData(s, ctx());
  for (const store of LOCAL_STORES) assert.equal(store.count(s, ctx()), 0);
  assert.equal(s.data.get(THEME_STORAGE_KEY), "light");
  assert.equal(s.data.get(MOTION_STORAGE_KEY), "reduce");
  assert.equal(s.data.get("someone-elses-key"), "untouched");
  assert.ok(s.data.has(draftKey("d1", "bob")));
});

test("no storage, or storage that throws, counts zero and clears without error", () => {
  const throwing: BrowserStorage = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("SecurityError");
    },
    removeItem: () => {
      throw new Error("SecurityError");
    },
    get length(): number {
      throw new Error("SecurityError");
    },
    key: () => {
      throw new Error("SecurityError");
    },
  };
  for (const s of [null, throwing]) {
    for (const store of LOCAL_STORES) {
      assert.equal(store.count(s, ctx()), 0);
      assert.doesNotThrow(() => store.clear(s, ctx()));
    }
    assert.doesNotThrow(() => clearAllLocalData(s, ctx()));
  }
});

test("every storage key the app defines is registered or deliberately excluded", () => {
  const exclusions = LOCAL_STORAGE_EXCLUSIONS.map((e) => e.key);
  for (const key of [
    `${DRAFT_KEY_PREFIX}d:u`,
    `${PROMPT_HISTORY_PREFIX}dashboard:w`,
    RECENT_KEY,
    RECENTS_STORAGE_KEY,
    THEME_STORAGE_KEY,
    MOTION_STORAGE_KEY,
  ]) {
    const owned = storeForKey(key) !== null || exclusions.some((m) => keyMatches(m, key));
    assert.ok(owned, `${key} is neither a local-data store nor an exclusion`);
  }
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const SRC = new URL("../src", import.meta.url).pathname;
const files = sourceFiles(SRC).map((path) => ({
  path: relative(SRC, path),
  text: readFileSync(path, "utf8"),
}));

/**
 * Every file that writes browser storage, and the store or exclusion that
 * covers what it writes. A new writer fails this test until it is registered
 * in `src/lib/local-data.ts` (or excluded there with a reason) and listed here.
 */
const STORAGE_WRITERS: Record<string, string> = {
  "lib/editor/drafts.ts": `${DRAFT_KEY_PREFIX}d:u`,
  "lib/prompt-history.ts": `${PROMPT_HISTORY_PREFIX}dashboard:w`,
  "lib/dashboard-list.ts": RECENT_KEY,
  "components/command-palette.tsx": RECENTS_STORAGE_KEY,
  "lib/theme.ts": THEME_STORAGE_KEY,
  "lib/motion.ts": MOTION_STORAGE_KEY,
};

test("every file that writes browser storage is accounted for", () => {
  const writers = files
    .filter((f) => f.path !== "lib/browser-storage.ts")
    .filter((f) => /\.setItem\(|sessionStorage/.test(f.text))
    .map((f) => f.path)
    .sort();
  assert.deepEqual(writers, Object.keys(STORAGE_WRITERS).sort());
  const exclusions = LOCAL_STORAGE_EXCLUSIONS.map((e) => e.key);
  for (const [path, key] of Object.entries(STORAGE_WRITERS)) {
    assert.ok(
      storeForKey(key) !== null || exclusions.some((m) => keyMatches(m, key)),
      `${path} writes ${key}, which nothing in local-data.ts covers`,
    );
  }
  assert.ok(
    !files.some((f) => /document\.cookie\s*=/.test(f.text)),
    "a client-side cookie write needs a local-data entry",
  );
});

/**
 * Every file that sets a cookie on the server, and the cookie names it sets.
 * A cookie jar is conventionally `store` or `jar` here; a file that names it
 * something else still has to import `cookies` from `next/headers`.
 */
const COOKIE_WRITERS: Record<string, string[]> = {
  "lib/auth/cookie.ts": ["holotable_session"],
  "app/api/auth/login/route.ts": ["holotable_oidc_state", "holotable_oidc_nonce"],
  "components/onboarding/actions.ts": [...DISMISSIBLE],
};

test("every cookie the server sets is resettable here or deliberately excluded", () => {
  const writers = files
    .filter(
      (f) =>
        /from "next\/headers"/.test(f.text) &&
        /\b(jar|store|cookieStore)\.set\(/.test(f.text),
    )
    .map((f) => f.path)
    .sort();
  assert.deepEqual(writers, Object.keys(COOKIE_WRITERS).sort());
  const known = new Set([
    ...LOCAL_COOKIES.map((c) => c.name),
    ...COOKIE_EXCLUSIONS.map((c) => c.name),
  ]);
  for (const [path, names] of Object.entries(COOKIE_WRITERS)) {
    for (const name of names)
      assert.ok(known.has(name), `${path} sets ${name}, uncovered`);
  }
  // The reset button goes through the dismissal action, so its cookie must be allowlisted there.
  for (const c of LOCAL_COOKIES) assert.ok(DISMISSIBLE.has(c.name));
  assert.ok(LOCAL_COOKIES.some((c) => c.name === SETUP_DISMISSED_COOKIE));
});

test("counts and ages read as words", () => {
  const drafts = LOCAL_STORES[0];
  assert.equal(describeCount(drafts, 0), "Empty");
  assert.equal(describeCount(drafts, 1), "1 draft");
  assert.equal(describeCount(drafts, 3), "3 drafts");
  assert.equal(formatBytes(840), "840 B");
  assert.equal(formatBytes(12_800), "13 KB");
  assert.equal(formatSavedAt(NOW - 5_000, NOW), "saved just now");
  assert.equal(formatSavedAt(NOW - 60_000, NOW), "saved 1 minute ago");
  assert.equal(formatSavedAt(NOW - 3 * 86_400_000, NOW), "saved 3 days ago");
});
