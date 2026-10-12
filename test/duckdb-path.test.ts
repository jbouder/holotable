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
import { DuckDbPathError, resolveSourcePath, SOURCES_DIR_UNSET } from "@/lib/duckdb/path";
import { DuckDbConfig, duckdbPathProblem } from "@/lib/sources/kinds/duckdb";

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

const refused = async (path: string, root: string, message: RegExp) => {
  await assert.rejects(resolveSourcePath(path, root), (err: unknown) => {
    assert.ok(err instanceof DuckDbPathError, String(err));
    assert.match(err.message, message);
    // A refusal never says where on the server anything is.
    assert.ok(!err.message.includes(root), err.message);
    return true;
  });
};

test("a directory or a .duckdb file inside the root resolves", async () => {
  const { root } = tree();
  const dir = await resolveSourcePath("sales", root);
  assert.equal(dir.layout, "directory");
  assert.equal(dir.absolute, join(root, "sales"));
  assert.equal(dir.root, root);
  const db = await resolveSourcePath("metrics.duckdb", root);
  assert.equal(db.layout, "database");
  // A symlink that stays inside the root is followed to where it lands.
  assert.equal((await resolveSourcePath("alias", root)).absolute, join(root, "sales"));
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
  await assert.rejects(resolveSourcePath("sales", ""), (err: unknown) => {
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
