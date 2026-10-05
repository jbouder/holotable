import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A checked-in JSON snapshot (#90).
 *
 * The value is compared as data, not as text, so the formatter rewrapping the
 * file is not a difference, and a real one is shown by `assert`'s structural
 * diff. `UPDATE_SNAPSHOTS=1 npm test` rewrites every snapshot a run touches
 * (and formats it, since Biome owns the layout of the repository's JSON); the
 * rewritten file then goes through review like any other change, which is the
 * point of keeping it.
 */
export function matchJsonSnapshot(url: URL, actual: unknown, what: string): void {
  const path = fileURLToPath(url);
  // Through JSON first: a Date, an undefined field or a class instance in
  // `actual` is compared as it would be stored.
  const value: unknown = JSON.parse(JSON.stringify(actual));
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
    execFileSync("npx", ["biome", "format", "--write", path], { stdio: "ignore" });
    return;
  }
  assert.ok(
    existsSync(path),
    `no snapshot of ${what} at ${path}; run UPDATE_SNAPSHOTS=1 npm test to write it`,
  );
  assert.deepEqual(
    value,
    JSON.parse(readFileSync(path, "utf8")),
    `${what} changed. If that is intended, run UPDATE_SNAPSHOTS=1 npm test and commit the snapshot with the change.`,
  );
}
