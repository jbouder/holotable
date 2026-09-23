import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "@/lib/auth/authorize";
import { parseGroups } from "@/lib/auth/claims";
import {
  DEFAULT_PREFERENCES,
  parsePreferences,
  parsePreferencesPatch,
  startDashboardId,
} from "@/lib/preferences";
import {
  type DashboardLookup,
  loadPreferences,
  type PreferenceStore,
  savePreferences,
  startHref,
} from "@/lib/preferences-server";

const DASH = "0f8fad5b-d9cb-469f-a165-70867728950e";
const viewer = parseGroups("u1", ["/workspaces/w/viewer"]);

/** An in-memory store that records which subject each call was for. */
function memoryStore(rows: Record<string, Record<string, unknown>> = {}) {
  const calls: string[] = [];
  const store: PreferenceStore = {
    async read(sub) {
      calls.push(`read:${sub}`);
      return rows[sub] ?? null;
    },
    async merge(sub, patch) {
      calls.push(`merge:${sub}`);
      rows[sub] = { ...(rows[sub] ?? {}), ...patch };
      return rows[sub];
    },
  };
  return { store, rows, calls };
}

const lookup =
  (known: Record<string, string>): DashboardLookup =>
  async (id) =>
    known[id] ? { workspaceId: known[id] } : null;

test("no row, or garbage, is the defaults", () => {
  assert.deepEqual(parsePreferences(null), DEFAULT_PREFERENCES);
  assert.deepEqual(parsePreferences("nope"), DEFAULT_PREFERENCES);
  assert.deepEqual(parsePreferences([1, 2]), DEFAULT_PREFERENCES);
});

test("a stored row with a stale key or a bad value still loads, field by field", () => {
  const prefs = parsePreferences({
    timeZone: "Europe/Berlin",
    clock: "sundial",
    retiredField: true,
    favoritesOnly: true,
  });
  assert.equal(prefs.timeZone, "Europe/Berlin");
  assert.equal(prefs.clock, DEFAULT_PREFERENCES.clock);
  assert.equal(prefs.favoritesOnly, true);
  assert.equal("retiredField" in prefs, false);
});

test("a patch with an unknown key or an invalid value is rejected, naming the field", () => {
  assert.deepEqual(parsePreferencesPatch({ theme: "dark" }), {
    ok: false,
    field: "theme",
    message: "is not a preference",
  });
  const badZone = parsePreferencesPatch({ timeZone: "Mars/Base" });
  assert.equal(badZone.ok, false);
  assert.equal(!badZone.ok && badZone.field, "timeZone");
  const badStart = parsePreferencesPatch({ startPage: "https://evil.example" });
  assert.equal(!badStart.ok && badStart.field, "startPage");
  assert.equal(parsePreferencesPatch({}).ok, false);
  assert.equal(parsePreferencesPatch([]).ok, false);
});

test("a valid patch passes through", () => {
  assert.deepEqual(
    parsePreferencesPatch({ clock: "24h", startPage: `dashboard:${DASH}` }),
    {
      ok: true,
      patch: { clock: "24h", startPage: `dashboard:${DASH}` },
    },
  );
  assert.equal(startDashboardId(`dashboard:${DASH}`), DASH);
  assert.equal(startDashboardId("explore"), null);
});

test("saving writes the caller's own row, and a body cannot name another subject", async () => {
  const { store, rows, calls } = memoryStore({ u2: { clock: "12h" } });
  const saved = await savePreferences(viewer, { clock: "24h" }, { store });
  assert.equal(saved.clock, "24h");
  assert.deepEqual(calls, ["merge:u1"]);
  assert.deepEqual(rows.u2, { clock: "12h" }, "someone else's row is untouched");
  await assert.rejects(
    savePreferences(viewer, { sub: "u2", clock: "24h" }, { store }),
    (err) => err instanceof HttpError && err.status === 400 && /sub/.test(err.message),
  );
  assert.deepEqual(calls, ["merge:u1"], "a rejected body writes nothing");
});

test("loading reads the caller's own row and survives a store that fails", async () => {
  const { store, calls } = memoryStore({ u1: { timeZone: "UTC" } });
  assert.equal((await loadPreferences(viewer, store)).timeZone, "UTC");
  assert.deepEqual(calls, ["read:u1"]);
  const broken: PreferenceStore = {
    read: async () => {
      throw new Error("database down");
    },
    merge: async () => ({}),
  };
  assert.deepEqual(await loadPreferences(viewer, broken), DEFAULT_PREFERENCES);
});

test("a start dashboard must be one the caller can view", async () => {
  const { store } = memoryStore();
  const known = lookup({ [DASH]: "w" });
  const ok = await savePreferences(
    viewer,
    { startPage: `dashboard:${DASH}` },
    { store, lookup: known },
  );
  assert.equal(ok.startPage, `dashboard:${DASH}`);
  const elsewhere = lookup({ [DASH]: "other" });
  await assert.rejects(
    savePreferences(
      viewer,
      { startPage: `dashboard:${DASH}` },
      { store, lookup: elsewhere },
    ),
    (err) => err instanceof HttpError && err.status === 400,
  );
  await assert.rejects(
    savePreferences(
      viewer,
      { startPage: `dashboard:${DASH}` },
      { store, lookup: lookup({}) },
    ),
    (err) => err instanceof HttpError && err.status === 400,
  );
});

test("the start page resolves, and a vanished or unreadable dashboard falls back with a notice", async () => {
  const base = { ...DEFAULT_PREFERENCES };
  assert.equal(await startHref(viewer, base), "/dashboards");
  assert.equal(await startHref(viewer, { ...base, startPage: "explore" }), "/explore");
  const start = { ...base, startPage: `dashboard:${DASH}` as const };
  assert.equal(
    await startHref(viewer, start, lookup({ [DASH]: "w" })),
    `/dashboards/${DASH}`,
  );
  assert.equal(
    await startHref(viewer, start, lookup({})),
    "/dashboards?notice=start-unavailable",
  );
  assert.equal(
    await startHref(viewer, start, lookup({ [DASH]: "other" })),
    "/dashboards?notice=start-unavailable",
  );
  const failing: DashboardLookup = async () => {
    throw new Error("database down");
  };
  assert.equal(
    await startHref(viewer, start, failing),
    "/dashboards?notice=start-unavailable",
  );
});
