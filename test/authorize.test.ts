import { test } from "node:test";
import assert from "node:assert/strict";
import { can, type Action } from "@/lib/auth/authorize";
import { parseGroups, type Identity } from "@/lib/auth/claims";

function identity(groups: string[], sub = "u1"): Identity {
  return parseGroups(sub, groups);
}

test("viewer may view but not create/update/generate", () => {
  const id = identity(["/workspaces/w/viewer"]);
  assert.equal(can(id, "dashboard:view", { workspaceId: "w" }), true);
  assert.equal(can(id, "source:use", { workspaceId: "w" }), true);
  assert.equal(can(id, "dashboard:create", { workspaceId: "w" }), false);
  assert.equal(can(id, "dashboard:update", { workspaceId: "w" }), false);
  assert.equal(can(id, "dashboard:generate", { workspaceId: "w" }), false);
});

test("editor may create/update/generate but not manage sources", () => {
  const id = identity(["/workspaces/w/editor"]);
  assert.equal(can(id, "dashboard:create", { workspaceId: "w" }), true);
  assert.equal(can(id, "dashboard:update", { workspaceId: "w" }), true);
  assert.equal(can(id, "dashboard:generate", { workspaceId: "w" }), true);
  assert.equal(can(id, "source:manage", { workspaceId: "w" }), false);
});

test("source-admin may manage sources", () => {
  const id = identity(["/workspaces/w/source-admin"]);
  assert.equal(can(id, "source:manage", { workspaceId: "w" }), true);
});

test("delete allowed for the dashboard owner (viewer role)", () => {
  const id = identity(["/workspaces/w/viewer"], "owner-1");
  assert.equal(
    can(id, "dashboard:delete", { workspaceId: "w", ownerSub: "owner-1" }),
    true,
  );
});

test("delete denied for a non-owner viewer", () => {
  const id = identity(["/workspaces/w/viewer"], "someone-else");
  assert.equal(
    can(id, "dashboard:delete", { workspaceId: "w", ownerSub: "owner-1" }),
    false,
  );
});

test("delete allowed for a source-admin who is not the owner", () => {
  const id = identity(["/workspaces/w/source-admin"], "not-owner");
  assert.equal(
    can(id, "dashboard:delete", { workspaceId: "w", ownerSub: "owner-1" }),
    true,
  );
});

test("all actions denied in a workspace the user has no role in", () => {
  const id = identity(["/workspaces/other/source-admin"]);
  const actions: Action[] = [
    "dashboard:view",
    "dashboard:create",
    "dashboard:update",
    "dashboard:generate",
    "dashboard:delete",
    "source:manage",
    "source:use",
  ];
  for (const a of actions) {
    assert.equal(can(id, a, { workspaceId: "w", ownerSub: "u1" }), false, a);
  }
});

test("platform admin bypasses every action in every workspace", () => {
  const id = identity(["/platform-admins"], "root");
  const actions: Action[] = [
    "dashboard:view",
    "dashboard:create",
    "dashboard:update",
    "dashboard:generate",
    "dashboard:delete",
    "source:manage",
    "source:use",
  ];
  for (const a of actions) {
    assert.equal(can(id, a, { workspaceId: "any-workspace" }), true, a);
  }
});

test("authorization is scoped to the passed workspace, not any owned one", () => {
  const id = identity(["/workspaces/w1/source-admin"]);
  assert.equal(can(id, "source:manage", { workspaceId: "w1" }), true);
  assert.equal(can(id, "source:manage", { workspaceId: "w2" }), false);
});
