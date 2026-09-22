import { test } from "node:test";
import assert from "node:assert/strict";
import { can, errorResponse, HttpError, type Action } from "@/lib/auth/authorize";
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
