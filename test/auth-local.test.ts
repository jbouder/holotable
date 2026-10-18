import { test } from "node:test";
import assert from "node:assert/strict";

import "./support/local-env";
import { LOCAL_DISPLAY_NAME, LOCAL_SUBJECT, mintedLogin } from "@/lib/auth/demo";
import { signSessionToken, verifySessionToken } from "@/lib/auth/session";
import { can } from "@/lib/auth/authorize";
import { mcpEnabled } from "@/lib/auth/mcp-token";
import { config } from "@/lib/config";
import { accountOrigin } from "@/lib/account";
import { GET as callback } from "@/app/api/auth/callback/route";
import { POST as refresh } from "@/app/api/auth/refresh/route";
import { POST as backchannelLogout } from "@/app/api/auth/backchannel-logout/route";
import { proxy } from "@/proxy";
import { NextRequest } from "next/server";

/*
 * Local mode (#600): demo mode's minting with one constant owner, who may
 * manage sources. Verification, claims and `can()` are the ordinary ones; the
 * guards are in test/config.test.ts.
 */

test("config reads local mode and the local owner's default groups", () => {
  assert.equal(config.authMode, "local");
  assert.deepEqual(config.localGroups, ["/workspaces/local/source-admin"]);
});

test("every local session names the one owner, through the ordinary session check", async () => {
  const subs = new Set<string>();
  for (let i = 0; i < 3; i++) {
    const { session } = await mintedLogin("local", "/", undefined, config.localGroups);
    assert.ok(session);
    const identity = await verifySessionToken(session);
    assert.ok(identity);
    assert.equal(identity.displayName, LOCAL_DISPLAY_NAME);
    subs.add(identity.sub);
  }
  assert.deepEqual([...subs], [LOCAL_SUBJECT]);
  assert.equal(LOCAL_SUBJECT, "local:owner");
});

test("the owner's valid session is kept; a dead one, or another mode's, is re-minted", async () => {
  const owner = await signSessionToken(LOCAL_SUBJECT, config.localGroups);
  assert.equal(
    (await mintedLogin("local", "/", owner, config.localGroups)).session,
    null,
  );

  const dead = await mintedLogin("local", "/", "not-a-token", config.localGroups);
  assert.ok(dead.session);

  // A volume that ran the demo first, on the same secret: not the owner.
  const visitor = await signSessionToken("demo:abc", ["/workspaces/demo/editor"]);
  const replaced = await mintedLogin("local", "/", visitor, config.localGroups);
  assert.ok(replaced.session);
  assert.equal((await verifySessionToken(replaced.session))?.sub, LOCAL_SUBJECT);
});

test("the owner manages sources in their workspace, and is no platform admin", async () => {
  const { session } = await mintedLogin("local", null, undefined, config.localGroups);
  assert.ok(session);
  const identity = await verifySessionToken(session);
  assert.ok(identity);
  const ctx = { workspaceId: "local" };
  assert.equal(identity.platformAdmin, false);
  assert.equal(can(identity, "source:manage", ctx), true);
  assert.equal(can(identity, "dashboard:create", ctx), true);
  assert.equal(can(identity, "source:manage", { workspaceId: "demo" }), false);
});

test("no realm: callback, renewal and back-channel logout are 404s, and MCP is off", async () => {
  const cb = await callback(
    new Request("http://localhost/api/auth/callback?code=a&state=b"),
  );
  assert.equal(cb.status, 404);
  const renew = await refresh(
    new Request("http://localhost/api/auth/refresh", { method: "POST" }),
  );
  assert.equal(renew.status, 404);
  const backchannel = await backchannelLogout(
    new Request("http://localhost/api/auth/backchannel-logout", {
      method: "POST",
      body: "logout_token=x",
    }),
  );
  assert.equal(backchannel.status, 404);
  // Even with every MCP setting present, local mode keeps /api/mcp closed.
  assert.equal(
    mcpEnabled({
      keys: (() => Promise.resolve({})) as never,
      issuer: "https://kc.example.com/realms/holotable",
      clientId: "holotable-mcp",
    }),
    false,
  );
});

test("a cookie-less page goes through local login, even after a sign-out", async () => {
  const page = await proxy(
    new NextRequest("http://localhost/dashboards", {
      headers: {
        "sec-fetch-dest": "document",
        cookie: `${config.signedOutCookieName}=1`,
      },
    }),
  );
  assert.equal(page.status, 307);
  assert.equal(new URL(page.headers.get("location") ?? "").pathname, "/api/auth/login");
});

test("the account page describes the server's owner, not an identity provider", () => {
  const origin = accountOrigin("local", "");
  assert.match(origin.profile, /owner/);
  assert.match(origin.roles, /LOCAL_GROUPS/);
  assert.doesNotMatch(origin.profile, /identity provider/);
});
