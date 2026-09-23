import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIONS,
  authorizedWorkspaces,
  can,
  errorResponse,
  HttpError,
  type Action,
} from "@/lib/auth/authorize";
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
  const actions: readonly Action[] = ACTIONS;
  for (const a of actions) {
    assert.equal(can(id, a, { workspaceId: "w", ownerSub: "u1" }), false, a);
  }
});

test("platform admin bypasses every action in every workspace", () => {
  const id = identity(["/platform-admins"], "root");
  const actions: readonly Action[] = ACTIONS;
  for (const a of actions) {
    assert.equal(can(id, a, { workspaceId: "any-workspace" }), true, a);
  }
});

test("only a platform admin may change a workspace's AI limits", () => {
  for (const role of ["viewer", "editor", "source-admin"]) {
    const id = identity([`/workspaces/w/${role}`]);
    assert.equal(can(id, "workspace:limits", { workspaceId: "w" }), false, role);
  }
  const admin = identity(["/platform-admins"], "root");
  assert.equal(can(admin, "workspace:limits", { workspaceId: "w" }), true);
  // Including a workspace the admin's claims do not name: limits can be set
  // ahead of a workspace's first use.
  assert.equal(can(admin, "workspace:limits", { workspaceId: "not-yet-used" }), true);
});

test("authorization is scoped to the passed workspace, not any owned one", () => {
  const id = identity(["/workspaces/w1/source-admin"]);
  assert.equal(can(id, "source:manage", { workspaceId: "w1" }), true);
  assert.equal(can(id, "source:manage", { workspaceId: "w2" }), false);
});

test("errorResponse sends an HttpError's status, message, and extra headers", async () => {
  const res = errorResponse(new HttpError(429, "slow down", { "Retry-After": "7" }));
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("Retry-After"), "7");
  // `kind` rides along so the client presents the error without inferring it
  // from the status; `requestId` is absent outside a request context.
  assert.deepEqual(await res.json(), { error: "slow down", kind: "rate_limit" });
  const plain = errorResponse(new HttpError(403, "no"));
  assert.equal(plain.headers.get("Retry-After"), null);
});

test("errorResponse takes an explicit kind over the one the status implies", async () => {
  // A failed statement and a malformed body are both 400s; only the thrower
  // knows which, so the query route says so.
  const res = errorResponse(new HttpError(400, "bad column", {}, "statement"));
  assert.deepEqual(await res.json(), { error: "bad column", kind: "statement" });
});

/* -------------------------------------------------------------------------- */
/* authorizedWorkspaces — the list filter                                     */
/* -------------------------------------------------------------------------- */

test("authorizedWorkspaces keeps only the workspaces the action is allowed in", () => {
  const id = identity(["/workspaces/a/viewer", "/workspaces/b/editor"]);
  assert.deepEqual(authorizedWorkspaces(id, "dashboard:view"), ["a", "b"]);
  assert.deepEqual(authorizedWorkspaces(id, "dashboard:update"), ["b"]);
});

test("a requested workspace id narrows the answer and never widens it", () => {
  const id = identity(["/workspaces/a/editor"]);
  assert.deepEqual(authorizedWorkspaces(id, "dashboard:update", "a"), ["a"]);
  // Not a member: the id in the request grants nothing, and the answer is
  // empty rather than a 403 that would confirm the workspace exists.
  assert.deepEqual(authorizedWorkspaces(id, "dashboard:update", "other"), []);
});

test("a viewer asking for editable dashboards gets nothing", () => {
  const id = identity(["/workspaces/a/viewer"]);
  assert.deepEqual(authorizedWorkspaces(id, "dashboard:update", "a"), []);
});

test("a platform admin is still limited to the workspaces in their claims", () => {
  const id = identity(["/platform-admins", "/workspaces/a/viewer"]);
  assert.equal(id.platformAdmin, true);
  assert.deepEqual(authorizedWorkspaces(id, "dashboard:update"), ["a"]);
});
