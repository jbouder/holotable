import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTIONS, can } from "@/lib/auth/authorize";
import { parseGroups, profileFromClaims, WORKSPACE_ROLES } from "@/lib/auth/claims";
import { signSessionToken, verifySessionToken } from "@/lib/auth/session";
import { accountSummary, CAPABILITIES, roleCapabilities } from "@/lib/account";
import { initials } from "@/lib/initials";

test("the profile is read from name, then preferred_username, and email", () => {
  assert.deepEqual(
    profileFromClaims({ name: "Ada Lovelace", email: "ada@example.com" }),
    {
      displayName: "Ada Lovelace",
      email: "ada@example.com",
    },
  );
  assert.deepEqual(profileFromClaims({ preferred_username: "ada" }), {
    displayName: "ada",
  });
  assert.deepEqual(profileFromClaims({ name: "  ", preferred_username: "ada" }), {
    displayName: "ada",
  });
});

test("a missing, blank or non-string claim leaves the field absent", () => {
  assert.deepEqual(profileFromClaims({}), {});
  assert.deepEqual(profileFromClaims({ name: 42, email: ["a@b.c"] }), {});
  assert.deepEqual(profileFromClaims({ name: "\n\t", email: "" }), {});
});

test("control characters are stripped and an oversized claim is clamped", () => {
  const p = profileFromClaims({
    name: "Ada\r\nLovelace\u0000",
    email: `${"a".repeat(400)}@x.io`,
  });
  assert.equal(p.displayName, "AdaLovelace");
  assert.equal(p.email?.length, 254);
});

test("the first-party session carries the profile through a sign and verify", async () => {
  const token = await signSessionToken("u1", ["/workspaces/w/editor"], {
    displayName: "Ada Lovelace",
    email: "ada@example.com",
  });
  const identity = await verifySessionToken(token);
  assert.ok(identity);
  assert.equal(identity.sub, "u1");
  assert.equal(identity.displayName, "Ada Lovelace");
  assert.equal(identity.email, "ada@example.com");
  assert.equal(identity.workspaces.w, "editor");
});

test("a session without a profile still verifies, with the fields absent", async () => {
  const identity = await verifySessionToken(await signSessionToken("u1", []));
  assert.ok(identity);
  assert.equal("displayName" in identity, false);
  assert.equal("email" in identity, false);
});

test("the display name and email play no part in any authorization decision", () => {
  const groups = [
    ["/workspaces/w/viewer"],
    ["/workspaces/w/editor"],
    ["/workspaces/w/source-admin"],
    ["/platform-admins"],
    [],
  ];
  const profiles = [
    {},
    { displayName: "Ada", email: "ada@example.com" },
    // A name shaped like a group or an admin claim must not be mistaken for one.
    { displayName: "/platform-admins", email: "/workspaces/other/source-admin" },
  ];
  for (const g of groups) {
    const base = parseGroups("u1", g);
    for (const profile of profiles) {
      const withProfile = { ...base, ...profile };
      for (const action of ACTIONS) {
        for (const workspaceId of ["w", "other"]) {
          for (const ownerSub of [undefined, "u1", "u2"]) {
            const ctx = { workspaceId, ownerSub };
            assert.equal(
              can(withProfile, action, ctx),
              can(base, action, ctx),
              `${action} in ${workspaceId} for ${g.join(",")} changed with the profile`,
            );
          }
        }
      }
    }
  }
});

test("the account summary is the identity's own, workspaces sorted", () => {
  const identity = {
    ...parseGroups("u1", ["/workspaces/b/viewer", "/workspaces/a/source-admin"]),
    displayName: "Ada",
  };
  assert.deepEqual(accountSummary(identity), {
    sub: "u1",
    displayName: "Ada",
    email: null,
    platformAdmin: false,
    workspaces: [
      { id: "a", role: "source-admin" },
      { id: "b", role: "viewer" },
    ],
  });
});

test("every action can() decides is described on the account page", () => {
  const described = new Set(CAPABILITIES.map((c) => c.action));
  for (const action of ACTIONS) {
    assert.ok(described.has(action), `${action} has no description in CAPABILITIES`);
  }
});

test("role descriptions come from can(), and each role allows what the one below does", () => {
  assert.deepEqual(roleCapabilities("viewer"), [
    "View dashboards",
    "Query data sources from dashboards and Explore",
    "Delete dashboards you created",
  ]);
  assert.ok(
    roleCapabilities("editor").includes("Generate dashboards and panels with AI"),
  );
  assert.ok(!roleCapabilities("editor").includes("Delete any dashboard"));
  assert.ok(
    roleCapabilities("source-admin").includes("Add, change and remove data sources"),
  );
  for (let i = 1; i < WORKSPACE_ROLES.length; i++) {
    const lower = roleCapabilities(WORKSPACE_ROLES[i - 1]);
    const higher = roleCapabilities(WORKSPACE_ROLES[i]);
    for (const label of lower)
      assert.ok(higher.includes(label), `${WORKSPACE_ROLES[i]} lost "${label}"`);
  }
});

test("initials use the first and last words, else the email, else nothing", () => {
  assert.equal(initials({ displayName: "Ada Lovelace" }), "AL");
  assert.equal(initials({ displayName: "Ada King Lovelace" }), "AL");
  assert.equal(initials({ displayName: "ada" }), "A");
  assert.equal(initials({ displayName: null, email: "zed@example.com" }), "Z");
  assert.equal(initials({}), null);
  assert.equal(initials({ displayName: "Émile Zola" }), "ÉZ");
});
