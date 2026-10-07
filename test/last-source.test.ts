import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultSourceId,
  LAST_SOURCE_KEY,
  readLastSource,
  writeLastSource,
} from "@/lib/source-selection";

/*
 * The new-dashboard page starts on the source last generated against in this
 * browser (#356). The value is read back as untrusted: it can only ever pick
 * from the list the server already authorized.
 */

const SOURCES = [{ id: "metrics" }, { id: "billing" }];

test("the remembered source wins when it is still offered", () => {
  assert.equal(defaultSourceId(SOURCES, "billing"), "billing");
});

test("a source no longer offered falls back to the first", () => {
  assert.equal(defaultSourceId(SOURCES, "gone"), "metrics");
  assert.equal(defaultSourceId(SOURCES, null), "metrics");
  assert.equal(defaultSourceId([], "metrics"), null);
});

test("storage that throws or holds junk reads as nothing", () => {
  const throwing = {
    getItem(): string | null {
      throw new Error("denied");
    },
    setItem(): void {
      throw new Error("quota");
    },
  };
  assert.equal(readLastSource(throwing), null);
  assert.doesNotThrow(() => writeLastSource(throwing, "metrics"));
  assert.equal(readLastSource({ getItem: () => "x".repeat(500) }), null);
  assert.equal(readLastSource(null), null);
});

test("a written source reads back", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  writeLastSource(storage, "billing");
  assert.equal(store.get(LAST_SOURCE_KEY), "billing");
  assert.equal(readLastSource(storage), "billing");
});

test("clearing recent prompts in settings also forgets the source", async () => {
  const { LOCAL_STORES } = await import("@/lib/local-data");
  const store = new Map<string, string>([[LAST_SOURCE_KEY, "billing"]]);
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    get length() {
      return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
  };
  const prompts = LOCAL_STORES.find((s) => s.id === "prompts");
  assert.ok(prompts);
  prompts.clear(storage, { userSub: "u", now: Date.now() });
  assert.equal(store.has(LAST_SOURCE_KEY), false);
});
