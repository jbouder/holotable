import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { parseGroups } from "@/lib/auth/claims";
import { STATIC_COMMANDS } from "@/lib/command-palette";
import {
  DEFAULT_SETTINGS_HREF,
  SETTINGS_SECTION_IDS,
  SETTINGS_SECTIONS,
  visibleSections,
} from "@/lib/settings";

const ids = (groups: string[]) =>
  visibleSections(parseGroups("u", groups)).map((s) => s.id);

test("every section has a unique id and a stable URL under /settings", () => {
  assert.deepEqual(
    SETTINGS_SECTIONS.map((s) => s.id),
    [...SETTINGS_SECTION_IDS],
  );
  for (const section of SETTINGS_SECTIONS) {
    assert.equal(section.href, `/settings/${section.id}`);
  }
});

test("every section's URL has a page behind it", () => {
  for (const section of SETTINGS_SECTIONS) {
    const page = new URL(`../src/app${section.href}/page.tsx`, import.meta.url);
    assert.ok(existsSync(page), `${section.href} has no page.tsx`);
  }
});

test("/settings lands on the first section, which everyone can see", () => {
  assert.equal(DEFAULT_SETTINGS_HREF, "/settings/account");
  assert.equal(ids([])[0], "account");
});

test("the workspaces section is only listed for someone who manages a workspace", () => {
  assert.ok(!ids([]).includes("workspaces"));
  assert.ok(!ids(["/workspaces/w/viewer"]).includes("workspaces"));
  assert.ok(!ids(["/workspaces/w/editor"]).includes("workspaces"));
  assert.ok(ids(["/workspaces/w/source-admin"]).includes("workspaces"));
  assert.ok(ids(["/platform-admins"]).includes("workspaces"));
});

test("the command palette offers Settings", () => {
  const command = STATIC_COMMANDS.find((c) => c.id === "page:settings");
  assert.deepEqual(command?.action, { type: "navigate", href: "/settings" });
});
