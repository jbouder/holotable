import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/*
 * Every third-party action in .github/workflows/ is pinned to a full commit
 * SHA. A tag such as `@v4` can be moved to different code by whoever controls
 * the action's repository; a SHA cannot. The trailing `# vX.Y.Z` comment is
 * what Dependabot reads and rewrites when it proposes an update, so an update
 * stays a reviewable pull request that changes the SHA and the comment
 * together.
 */

const WORKFLOWS = ".github/workflows";
const PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/;

function usesLines(): { file: string; line: number; ref: string }[] {
  return readdirSync(WORKFLOWS)
    .filter((name) => /\.ya?ml$/.test(name))
    .flatMap((name) => {
      const file = join(WORKFLOWS, name);
      return readFileSync(file, "utf8")
        .split("\n")
        .flatMap((text, i) => {
          const match = /^\s*(?:-\s+)?uses:\s*(.+?)\s*$/.exec(text);
          return match ? [{ file, line: i + 1, ref: match[1] }] : [];
        });
    });
}

test("the workflows use at least one action", () => {
  assert.ok(usesLines().length > 0);
});

test("every action is pinned to a commit SHA with its version in a comment", () => {
  const unpinned = usesLines()
    .filter(({ ref }) => !ref.startsWith("./") && !PINNED.test(ref))
    .map(({ file, line, ref }) => `${file}:${line} ${ref}`);
  assert.deepEqual(
    unpinned,
    [],
    "pin each to `owner/repo@<40-hex sha> # vX.Y.Z` (resolve the tag with `gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`)",
  );
});

test("one action is pinned to one version everywhere it is used", () => {
  const versions = new Map<string, Set<string>>();
  for (const { ref } of usesLines()) {
    const [action, pin] = ref.split("@");
    if (!pin) continue;
    versions.set(action, (versions.get(action) ?? new Set()).add(pin));
  }
  const split = [...versions]
    .filter(([, pins]) => pins.size > 1)
    .map(([action]) => action);
  assert.deepEqual(split, [], "every use of an action should carry the same pin");
});
