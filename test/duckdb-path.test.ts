import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DuckDbPathError,
  listSourcePaths,
  resolveSourcePath,
  SOURCES_DIR_UNSET,
} from "@/lib/duckdb/path";
import {
  DuckDbConfig,
  duckdbPathProblem,
  uploadScopeProblem,
} from "@/lib/sources/kinds/duckdb";

/**
 * The DuckDB path guard (#572): a source's path is as untrusted as a URL, so
 * it resolves inside `DUCKDB_SOURCES_DIR`, symlinks followed, or not at all.
 * Real files under a temporary root, because a guard that only ever met
 * strings has not met a symlink.
 */

function tree() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "holotable-duckdb-path-")));
  const root = join(base, "root");
  const outside = join(base, "outside");
  mkdirSync(join(root, "sales"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, "sales", "orders.csv"), "a\n1\n");
  writeFileSync(join(root, "metrics.duckdb"), "");
  writeFileSync(join(outside, "secret.duckdb"), "");
  writeFileSync(join(root, "notes.txt"), "");
  symlinkSync(outside, join(root, "escape"));
  symlinkSync(join(outside, "secret.duckdb"), join(root, "linked.duckdb"));
  symlinkSync(join(root, "sales"), join(root, "alias"));
  return { base, root, outside };
}

const refused = async (
  path: string,
  root: string,
  message: RegExp,
  workspaceId = "ws",
) => {
  await assert.rejects(resolveSourcePath(path, workspaceId, root), (err: unknown) => {
    assert.ok(err instanceof DuckDbPathError, String(err));
    assert.match(err.message, message);
    // A refusal never says where on the server anything is.
    assert.ok(!err.message.includes(root), err.message);
    return true;
  });
};

test("a directory or a .duckdb file inside the root resolves", async () => {
  const { root } = tree();
  const dir = await resolveSourcePath("sales", "ws", root);
  assert.equal(dir.layout, "directory");
  assert.equal(dir.absolute, join(root, "sales"));
  assert.equal(dir.root, root);
  const db = await resolveSourcePath("metrics.duckdb", "ws", root);
  assert.equal(db.layout, "database");
  // A symlink that stays inside the root is followed to where it lands.
  assert.equal(
    (await resolveSourcePath("alias", "ws", root)).absolute,
    join(root, "sales"),
  );
});

test("..  and absolute paths are refused before the filesystem is asked", async () => {
  const { root, outside } = tree();
  await refused("../outside", root, /must not contain "\.\."/);
  await refused("sales/../../outside", root, /must not contain "\.\."/);
  await refused(outside, root, /relative to DUCKDB_SOURCES_DIR/);
  await refused("/etc", root, /relative to DUCKDB_SOURCES_DIR/);
  await refused("C:/data", root, /relative/);
  await refused("sales\\..\\x", root, /backslash/);
  await refused("./sales", root, /"\." segment/);
  await refused("sales//x", root, /empty/);
  await refused(`a${"b".repeat(600)}`, root, /at most 512/);
});

test("a symlink out of the root is refused, whether a directory or a database", async () => {
  const { root } = tree();
  await refused("escape", root, /outside DUCKDB_SOURCES_DIR/);
  await refused("linked.duckdb", root, /outside DUCKDB_SOURCES_DIR/);
  await refused("escape/secret.duckdb", root, /outside DUCKDB_SOURCES_DIR/);
});

test("a path must be what it says: a directory, or a .duckdb file", async () => {
  const { root } = tree();
  await refused("notes.txt", root, /not a directory/);
  await refused("sales/orders.csv", root, /not a directory/);
  await refused("missing", root, /does not exist/);
  mkdirSync(join(root, "folder.duckdb"));
  await refused("folder.duckdb", root, /not a file/);
});

test("with DUCKDB_SOURCES_DIR unset every path is refused, naming the variable", async () => {
  await assert.rejects(resolveSourcePath("sales", "ws", ""), (err: unknown) => {
    assert.ok(err instanceof DuckDbPathError);
    assert.equal(err.message, SOURCES_DIR_UNSET);
    assert.match(err.message, /DUCKDB_SOURCES_DIR/);
    return true;
  });
});

test("the config refuses the same paths the guard refuses lexically", () => {
  const tables = [{ name: "t", columns: [{ name: "v", type: "BIGINT" }] }];
  const parses = (path: string) =>
    DuckDbConfig.safeParse({ kind: "duckdb", path, tables }).success;
  assert.ok(parses("sales"));
  assert.ok(parses("lake/2026/metrics.duckdb"));
  for (const bad of ["", "/abs", "../x", "a/../b", "a\\b", "a\u0000b", ".", "a//b"]) {
    assert.equal(parses(bad), false, bad);
    assert.notEqual(duckdbPathProblem(bad), null, bad);
  }
  // No credentials, no connection detail: the config is the path and the catalog.
  assert.equal(
    DuckDbConfig.safeParse({ kind: "duckdb", path: "x", tables, host: "h" }).success,
    false,
  );
});

/**
 * Uploads (#595) land under `uploads/<workspaceId>/<dir>`, and a source may
 * name only its own workspace's. The guard holds that on the path as typed
 * and on where it resolves, and the guard is what both the save check and
 * every open run (`duckdbConfigProblem`, `prepare` in the client), so this is
 * the rule on save and on execution alike; test/duckdb.test.ts runs both.
 */
function uploadsTree() {
  const { base, root } = tree();
  mkdirSync(join(root, "uploads", "ops", "a1"), { recursive: true });
  mkdirSync(join(root, "uploads", "fin", "b2"), { recursive: true });
  writeFileSync(join(root, "uploads", "ops", "a1", "orders.csv"), "a\n1\n");
  writeFileSync(join(root, "uploads", "fin", "b2", "ledger.csv"), "a\n1\n");
  // An operator's symlink elsewhere under the root, into a workspace's uploads.
  symlinkSync(join(root, "uploads", "fin", "b2"), join(root, "shortcut"));
  return { base, root };
}

test("a source names only its own workspace's upload directories, as typed (#595)", () => {
  assert.equal(uploadScopeProblem("uploads/ops/a1", "ops"), null);
  assert.equal(uploadScopeProblem("sales", "ops"), null);
  for (const path of [
    "uploads/fin/b2",
    "uploads/ops",
    "uploads",
    "uploads/ops/a1/deeper",
    "Uploads/fin/b2",
    "UPLOADS/fin/b2/",
  ]) {
    assert.notEqual(uploadScopeProblem(path, "ops"), null, path);
  }
  // It names no path, only the rule.
  assert.doesNotMatch(String(uploadScopeProblem("uploads/fin/b2", "ops")), /fin|b2/);
});

test("the guard refuses another workspace's uploads, however the path gets there (#595)", async () => {
  const { root } = uploadsTree();
  const own = await resolveSourcePath("uploads/ops/a1", "ops", root);
  assert.equal(own.absolute, join(root, "uploads", "ops", "a1"));
  await refused("uploads/fin/b2", root, /upload directory of this workspace/, "ops");
  await refused("uploads/ops", root, /upload directory of this workspace/, "ops");
  await refused("uploads", root, /upload directory of this workspace/, "ops");
  // The same directory is fine for its own workspace...
  await resolveSourcePath("uploads/fin/b2", "fin", root);
  // ...and a symlink that lands in it is judged by where it lands.
  await refused("shortcut", root, /outside this workspace's own upload/, "ops");
});

test("the path picker never offers uploads, nor a link into them (#595)", async () => {
  const { root } = uploadsTree();
  const names = (await listSourcePaths(root)).map((p) => p.name);
  assert.ok(names.includes("sales"));
  assert.ok(!names.includes("uploads"), names.join());
  assert.ok(!names.includes("shortcut"), names.join());
});
