import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseGroups,
  hasWorkspaceRole,
  accessibleWorkspaces,
  PLATFORM_ADMIN_GROUP,
} from "@/lib/auth/claims";

test("parses per-workspace roles from group paths", () => {
  const id = parseGroups("u1", [
    "/workspaces/team-a/viewer",
    "/workspaces/team-b/editor",
  ]);
  assert.equal(id.sub, "u1");
  assert.equal(id.platformAdmin, false);
  assert.equal(id.workspaces["team-a"], "viewer");
  assert.equal(id.workspaces["team-b"], "editor");
});

test("highest role wins within a workspace", () => {
  const id = parseGroups("u1", [
    "/workspaces/team-a/viewer",
    "/workspaces/team-a/source-admin",
    "/workspaces/team-a/editor",
  ]);
  assert.equal(id.workspaces["team-a"], "source-admin");
});

test("role order is independent of group order", () => {
  const a = parseGroups("u", ["/workspaces/w/source-admin", "/workspaces/w/viewer"]);
  const b = parseGroups("u", ["/workspaces/w/viewer", "/workspaces/w/source-admin"]);
  assert.equal(a.workspaces["w"], "source-admin");
  assert.equal(b.workspaces["w"], "source-admin");
});

test("detects the platform admin group", () => {
  const id = parseGroups("root", [PLATFORM_ADMIN_GROUP]);
  assert.equal(id.platformAdmin, true);
});

test("tolerates missing leading slash", () => {
  const id = parseGroups("u", ["workspaces/w/editor", "platform-admins"]);
  assert.equal(id.workspaces["w"], "editor");
  assert.equal(id.platformAdmin, true);
});

test("ignores malformed / unknown groups (fail closed)", () => {
  const id = parseGroups("u", [
    "/workspaces/w",
    "/workspaces/w/superuser",
    "/random/thing",
    "/workspaces//viewer",
    "",
  ]);
  assert.deepEqual(id.workspaces, {});
  assert.equal(id.platformAdmin, false);
});

test("hasWorkspaceRole respects the role hierarchy", () => {
  const id = parseGroups("u", ["/workspaces/w/editor"]);
  assert.equal(hasWorkspaceRole(id, "w", "viewer"), true);
  assert.equal(hasWorkspaceRole(id, "w", "editor"), true);
  assert.equal(hasWorkspaceRole(id, "w", "source-admin"), false);
  assert.equal(hasWorkspaceRole(id, "other", "viewer"), false);
});

test("platform admin satisfies any workspace role", () => {
  const id = parseGroups("root", [PLATFORM_ADMIN_GROUP]);
  assert.equal(hasWorkspaceRole(id, "anything", "source-admin"), true);
});

test("accessibleWorkspaces lists sorted workspace ids", () => {
  const id = parseGroups("u", [
    "/workspaces/b/viewer",
    "/workspaces/a/editor",
  ]);
  assert.deepEqual(accessibleWorkspaces(id), ["a", "b"]);
});
