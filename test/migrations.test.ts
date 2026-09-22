import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import {
  digestRows,
  loadMigrations,
  orphanedMigrations,
  parseArgs,
  parseMigration,
  pendingMigrations,
  withAdvisoryLock,
} from "../scripts/lib/migrations";

/**
 * Migration safety (#57).
 *
 * The parsing, planning and argument rules are unit tested here; the parts
 * that need a real server — the down path and idempotency — are exercised by
 * `npm run migrate:verify` in CI, which needs a database it may destroy. The
 * advisory-lock test at the end sits between the two: it needs a server but
 * touches nothing, so it runs whenever MIGRATE_TEST_DATABASE_URL is set and
 * skips otherwise.
 */

// ---------------------------------------------------------------------------
// Parsing a migration file
// ---------------------------------------------------------------------------

test("a rollback section splits the file into up and down", () => {
  const m = parseMigration(
    "010_thing.sql",
    ["CREATE TABLE thing (id INT);", "", "-- rollback:", "DROP TABLE thing;", ""].join(
      "\n",
    ),
  );
  assert.equal(m.name, "010_thing.sql");
  assert.match(m.up, /CREATE TABLE thing/);
  assert.doesNotMatch(m.up, /DROP TABLE/);
  assert.match(m.down ?? "", /DROP TABLE thing/);
  assert.doesNotMatch(m.down ?? "", /CREATE TABLE/);
  assert.equal(m.irreversible, null);
});

test("an irreversible marker records the reason and keeps the whole file as up", () => {
  const m = parseMigration(
    "011_drop.sql",
    "-- irreversible: the dropped column's values are not recoverable\nALTER TABLE t DROP COLUMN c;\n",
  );
  assert.equal(m.down, null);
  assert.equal(m.irreversible, "the dropped column's values are not recoverable");
  assert.match(m.up, /DROP COLUMN c/);
});

test("a migration declaring neither a rollback nor a reason is rejected", () => {
  assert.throws(
    () => parseMigration("012_bare.sql", "CREATE TABLE t (id INT);\n"),
    /missing a down path/,
  );
});

test("a migration declaring both is rejected", () => {
  assert.throws(
    () =>
      parseMigration(
        "013_both.sql",
        "-- irreversible: nope\nCREATE TABLE t (id INT);\n-- rollback:\nDROP TABLE t;\n",
      ),
    /both/,
  );
});

test("an empty rollback section is rejected rather than read as a no-op", () => {
  assert.throws(
    () =>
      parseMigration(
        "014_empty.sql",
        "CREATE TABLE t (id INT);\n-- rollback:\n-- nothing to do\n",
      ),
    /empty/,
  );
});

test("the marker must be its own line, so prose mentioning it is left alone", () => {
  const m = parseMigration(
    "015_prose.sql",
    "-- See docs for the rollback: convention.\nCREATE TABLE t (id INT);\n-- rollback:\nDROP TABLE t;\n",
  );
  assert.match(m.up, /See docs for the rollback: convention/);
  assert.equal((m.down ?? "").trim(), "DROP TABLE t;");
});

// ---------------------------------------------------------------------------
// The migrations actually in the repository
// ---------------------------------------------------------------------------

test("every migration in migrations/ declares a down path or a reason", () => {
  const all = loadMigrations();
  assert.ok(all.length > 0, "expected at least one migration");
  for (const m of all) {
    const declared = m.down !== null || m.irreversible !== null;
    assert.ok(declared, `${m.name} declares neither a rollback nor a reason`);
    if (m.irreversible !== null) {
      assert.ok(
        m.irreversible.length > 10,
        `${m.name}: the irreversible reason should say why, not just that`,
      );
    }
  }
});

test("migrations are loaded in filename order", () => {
  const names = loadMigrations().map((m) => m.name);
  assert.deepEqual(names, [...names].sort());
});

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

const fake = (name: string) => ({ name, up: "", down: "", irreversible: null });

test("pending is everything not recorded as applied, in order", () => {
  const all = [fake("001_a.sql"), fake("002_b.sql"), fake("003_c.sql")];
  assert.deepEqual(
    pendingMigrations(all, ["001_a.sql"]).map((m) => m.name),
    ["002_b.sql", "003_c.sql"],
  );
  assert.deepEqual(pendingMigrations(all, ["001_a.sql", "002_b.sql", "003_c.sql"]), []);
});

test("an applied migration missing from the checkout is reported as orphaned", () => {
  const all = [fake("001_a.sql")];
  assert.deepEqual(orphanedMigrations(all, ["001_a.sql", "002_newer.sql"]), [
    "002_newer.sql",
  ]);
  assert.deepEqual(orphanedMigrations(all, ["001_a.sql"]), []);
});

// ---------------------------------------------------------------------------
// The CLI contract
// ---------------------------------------------------------------------------

test("no arguments means apply everything", () => {
  assert.deepEqual(parseArgs([]), {
    mode: "apply",
    target: null,
    lockTimeoutMs: 60_000,
  });
});

test("each mode flag selects its mode", () => {
  assert.equal(parseArgs(["--check"]).mode, "check");
  assert.equal(parseArgs(["--dry-run"]).mode, "dry-run");
  const down = parseArgs(["--down", "003_llm_limits.sql"]);
  assert.equal(down.mode, "down");
  assert.equal(down.target, "003_llm_limits.sql");
});

test("--lock-timeout is read in seconds", () => {
  assert.equal(parseArgs(["--lock-timeout", "5"]).lockTimeoutMs, 5000);
  assert.equal(parseArgs(["--check", "--lock-timeout", "0"]).lockTimeoutMs, 0);
});

test("conflicting modes, a bare --down, and unknown flags are rejected", () => {
  assert.throws(() => parseArgs(["--check", "--dry-run"]), /cannot be combined/);
  assert.throws(() => parseArgs(["--down"]), /needs the name/);
  assert.throws(() => parseArgs(["--down", "--check"]), /needs the name/);
  assert.throws(() => parseArgs(["--lock-timeout", "soon"]), /non-negative/);
  assert.throws(() => parseArgs(["--lock-timeout", "-1"]), /non-negative/);
  assert.throws(() => parseArgs(["--apply-everything"]), /Unknown argument/);
});

// ---------------------------------------------------------------------------
// Schema fingerprinting
// ---------------------------------------------------------------------------

test("the digest is stable for the same rows and changes with them", () => {
  const rows = [[{ table_name: "t", column_name: "id" }], [], []];
  assert.equal(digestRows(rows), digestRows(structuredClone(rows)));
  assert.notEqual(
    digestRows(rows),
    digestRows([[{ table_name: "t", column_name: "id2" }], [], []]),
  );
  // Order is part of the fingerprint: the queries behind it are all ORDER BY,
  // so a difference in order is a real difference in the catalog.
  assert.notEqual(
    digestRows([[{ a: 1 }, { a: 2 }], [], []]),
    digestRows([[{ a: 2 }, { a: 1 }], [], []]),
  );
});

// ---------------------------------------------------------------------------
// The advisory lock, against a real server
// ---------------------------------------------------------------------------

const dbUrl = process.env.MIGRATE_TEST_DATABASE_URL;

test("two runners cannot hold the migration lock at once", {
  skip: dbUrl ? false : "set MIGRATE_TEST_DATABASE_URL to run",
}, async () => {
  const holder = new Client({ connectionString: dbUrl });
  const contender = new Client({ connectionString: dbUrl });
  await holder.connect();
  await contender.connect();
  try {
    let contenderRan = false;
    let released = false;

    await withAdvisoryLock(holder, 1000, async () => {
      // A second runner with a short timeout gives up rather than hanging.
      await assert.rejects(
        withAdvisoryLock(contender, 500, async () => {
          contenderRan = true;
        }),
        /Timed out .* waiting for the migration advisory lock/,
      );
      assert.equal(contenderRan, false, "the contender must not enter the body");
      released = true;
    });

    assert.equal(released, true);

    // Once the holder is out, the lock is free again.
    let second = false;
    await withAdvisoryLock(contender, 2000, async () => {
      second = true;
    });
    assert.equal(second, true);
  } finally {
    await holder.end();
    await contender.end();
  }
});
