import { test } from "node:test";
import assert from "node:assert/strict";
import {
  copyDashboardTitle,
  DashboardDescription,
  DashboardTags,
  DESCRIPTION_MAX,
  escapeLike,
  MAX_TAGS,
  normalizeTag,
  normalizeTags,
  parseTagInput,
  TAG_MAX,
  TITLE_AUTHORITY,
} from "@/lib/dashboard-metadata";

/* -------------------------------------------------------------------------- */
/* Tags                                                                       */
/* -------------------------------------------------------------------------- */

test("a tag is trimmed, collapsed, lowercased, and bounded", () => {
  assert.equal(normalizeTag("  Prod  "), "prod");
  assert.equal(normalizeTag("Page\t\n Load"), "page load");
  assert.equal(normalizeTag("PROD"), "prod");
  assert.equal(normalizeTag("x".repeat(TAG_MAX + 10)).length, TAG_MAX);
  assert.equal(normalizeTag("   "), "");
});

test("truncation never leaves a trailing space behind", () => {
  // Slicing mid-word would otherwise produce `"…foo "`, and two tags that
  // differ only by that space would be two shelves.
  const tag = normalizeTag(`${"a".repeat(TAG_MAX - 1)} bbb`);
  assert.equal(tag, "a".repeat(TAG_MAX - 1));
});

test("case and whitespace variants of one tag collapse to one", () => {
  assert.deepEqual(normalizeTags(["Prod", "prod", " PROD "]), ["prod"]);
});

test("tags come back sorted, so two dashboards tagged alike read alike", () => {
  assert.deepEqual(normalizeTags(["web", "api", "db"]), ["api", "db", "web"]);
  assert.deepEqual(normalizeTags(["db", "web", "api"]), ["api", "db", "web"]);
});

test("the cap is applied after deduplication", () => {
  // Thirteen distinct tags lose one; thirteen spellings of one keep it.
  const many = Array.from({ length: MAX_TAGS + 1 }, (_, i) => `tag-${i}`);
  assert.equal(normalizeTags(many).length, MAX_TAGS);
  assert.deepEqual(normalizeTags(Array(MAX_TAGS + 1).fill("Prod")), ["prod"]);
});

test("typed input splits on commas and not on spaces", () => {
  assert.deepEqual(parseTagInput("prod, page load ,,"), ["page load", "prod"]);
  assert.deepEqual(parseTagInput(""), []);
});

test("the tags schema normalizes and refuses an absurd body", () => {
  assert.deepEqual(DashboardTags.parse([" API ", "api", "Web"]), ["api", "web"]);
  assert.equal(DashboardTags.safeParse(Array(MAX_TAGS * 4 + 1).fill("x")).success, false);
  assert.equal(DashboardTags.safeParse(["x".repeat(TAG_MAX * 4 + 1)]).success, false);
});

/* -------------------------------------------------------------------------- */
/* Description                                                                */
/* -------------------------------------------------------------------------- */

test("a blank description is null, not an empty string", () => {
  assert.equal(DashboardDescription.parse("   "), null);
  assert.equal(DashboardDescription.parse(" hello "), "hello");
});

test("a description longer than the column's bound is refused", () => {
  assert.equal(DashboardDescription.safeParse("x".repeat(DESCRIPTION_MAX)).success, true);
  assert.equal(
    DashboardDescription.safeParse("x".repeat(DESCRIPTION_MAX + 1)).success,
    false,
  );
});

/* -------------------------------------------------------------------------- */
/* Copies and search                                                          */
/* -------------------------------------------------------------------------- */

test("a copy's title stays inside the IR's 200-character bound", () => {
  assert.equal(copyDashboardTitle("Errors"), "Errors (copy)");
  assert.equal(copyDashboardTitle("x".repeat(400)).length, 200);
  assert.ok(copyDashboardTitle("x".repeat(400)).endsWith(" (copy)"));
});

test("search text is escaped so wildcards are searched for, not applied", () => {
  assert.equal(escapeLike("100%"), "100\\%");
  assert.equal(escapeLike("a_b"), "a\\_b");
  // The backslash is escaped first, or it would escape the escapes.
  assert.equal(escapeLike("a\\%"), "a\\\\\\%");
  assert.equal(escapeLike("plain"), "plain");
});

test("the title's authority is the spec, and it is recorded as such", () => {
  // The constant is the decision #119 asked to be made explicit: a rename
  // appends a version rather than updating the row, because the row's title is
  // a mirror of `spec.title`.
  assert.equal(TITLE_AUTHORITY, "spec");
});
