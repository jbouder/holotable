import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";

import "./support/demo-env";
import { demoLogin, demoSubject, DEMO_DISPLAY_NAME, safeNextPath } from "@/lib/auth/demo";
import { verifySessionToken, signSessionToken } from "@/lib/auth/session";
import { can } from "@/lib/auth/authorize";
import { config } from "@/lib/config";
import { accountOrigin } from "@/lib/account";
import { GET as callback } from "@/app/api/auth/callback/route";
import { POST as refresh } from "@/app/api/auth/refresh/route";
import { POST as backchannelLogout } from "@/app/api/auth/backchannel-logout/route";
import { proxy, config as proxyConfig } from "@/proxy";
import { NextRequest } from "next/server";

test("config reads demo mode and the demo groups", () => {
  assert.equal(config.authMode, "demo");
  assert.deepEqual(config.demoGroups, ["/workspaces/demo/editor"]);
});

test("a minted demo session verifies through the ordinary session check", async () => {
  const { location, session } = await demoLogin(
    "/dashboards",
    undefined,
    config.demoGroups,
  );
  assert.equal(location, "/dashboards");
  assert.ok(session, "a visitor without a session gets one");
  const identity = await verifySessionToken(session);
  assert.ok(identity);
  assert.match(identity.sub, /^demo:[0-9a-f]{24}$/);
  assert.equal(identity.displayName, DEMO_DISPLAY_NAME);
  assert.equal(identity.platformAdmin, false);
  assert.deepEqual(identity.workspaces, { demo: "editor" });
});

test("every visitor gets their own subject", () => {
  const subs = new Set(Array.from({ length: 50 }, () => demoSubject()));
  assert.equal(subs.size, 50);
});

test("a visitor with a valid session keeps it; a dead one is replaced", async () => {
  const existing = await signSessionToken("demo:abc", ["/workspaces/demo/editor"]);
  const kept = await demoLogin("/", existing, config.demoGroups);
  assert.equal(kept.session, null);

  const replaced = await demoLogin("/", "not-a-token", config.demoGroups);
  assert.ok(replaced.session);
  assert.ok(await verifySessionToken(replaced.session));
});

test("the demo identity cannot manage sources, delete others' work, or change limits", async () => {
  const { session } = await demoLogin(null, undefined, config.demoGroups);
  assert.ok(session);
  const identity = await verifySessionToken(session);
  assert.ok(identity);
  const ctx = { workspaceId: "demo" };
  assert.equal(can(identity, "dashboard:view", ctx), true);
  assert.equal(can(identity, "dashboard:create", ctx), true);
  assert.equal(can(identity, "source:manage", ctx), false);
  assert.equal(
    can(identity, "dashboard:delete", { workspaceId: "demo", ownerSub: "someone-else" }),
    false,
  );
  assert.equal(can(identity, "workspace:limits", ctx), false);
  // Nothing outside the demo workspace.
  assert.equal(can(identity, "dashboard:view", { workspaceId: "ops" }), false);
});

test("next must be a same-origin path, or it falls back to /", () => {
  for (const ok of ["/", "/dashboards", "/dashboards/abc?from=now-1h&to=now", "/a#b"]) {
    assert.equal(safeNextPath(ok), ok, ok);
  }
  for (const bad of [
    null,
    undefined,
    "",
    "dashboards",
    "//evil.example.com",
    "/\\evil.example.com",
    "https://evil.example.com/",
    "javascript:alert(1)",
    "/x\r\nSet-Cookie: a=b",
    "/x\\y",
    `/${"a".repeat(3000)}`,
  ]) {
    assert.equal(safeNextPath(bad), "/", String(bad));
  }
});

test("a bad next sends the freshly minted visitor home", async () => {
  const { location } = await demoLogin(
    "//evil.example.com/x",
    undefined,
    config.demoGroups,
  );
  assert.equal(location, "/");
});

test("the OIDC callback is a 404 in demo mode", async () => {
  const res = await callback(
    new Request("http://localhost/api/auth/callback?code=a&state=b"),
  );
  assert.equal(res.status, 404);
});

test("session renewal is a 404 in demo mode: there is no realm to ask", async () => {
  const res = await refresh(
    new Request("http://localhost/api/auth/refresh", { method: "POST" }),
  );
  assert.equal(res.status, 404);
});

test("back-channel logout is a 404 in demo mode: there is no realm to hear from", async () => {
  const res = await backchannelLogout(
    new Request("http://localhost/api/auth/backchannel-logout", {
      method: "POST",
      body: "logout_token=x",
    }),
  );
  assert.equal(res.status, 404);
});

// Session renewal (#27) mints only from a realm-issued id_token, and
// back-channel logout (#28) only ever ends sessions. Anything else here is a
// new way in and needs the same scrutiny.
test("there are still exactly five auth routes", () => {
  const dir = new URL("../src/app/api/auth", import.meta.url);
  assert.deepEqual(readdirSync(dir).sort(), [
    "backchannel-logout",
    "callback",
    "login",
    "logout",
    "refresh",
  ]);
});

test("a cookie-less page request is sent through demo login; an API request is not", async () => {
  const navigation = { "sec-fetch-dest": "document" };
  const page = await proxy(
    new NextRequest("http://localhost/dashboards?tag=x", { headers: navigation }),
  );
  assert.equal(page.status, 307);
  const location = new URL(page.headers.get("location") ?? "");
  assert.equal(location.origin, "http://localhost");
  assert.equal(location.pathname, "/api/auth/login");
  assert.equal(location.searchParams.get("next"), "/dashboards?tag=x");

  assert.equal(page.headers.get("cache-control"), "no-store");

  // Behind a reverse proxy or a Worker the redirect follows the visitor's host.
  const proxied = await proxy(
    new NextRequest("http://0.0.0.0:3000/explore", {
      headers: {
        ...navigation,
        host: "0.0.0.0:3000",
        "x-forwarded-host": "demo.example.com",
        "x-forwarded-proto": "https",
      },
    }),
  );
  assert.equal(
    new URL(proxied.headers.get("location") ?? "").origin,
    "https://demo.example.com",
  );
  const hosted = await proxy(
    new NextRequest("http://0.0.0.0:3000/explore", {
      headers: { ...navigation, host: "localhost:3000" },
    }),
  );
  assert.equal(
    new URL(hosted.headers.get("location") ?? "").origin,
    "http://localhost:3000",
  );

  const withCookie = await proxy(
    new NextRequest("http://localhost/dashboards", {
      headers: { ...navigation, cookie: `${config.sessionCookieName}=anything` },
    }),
  );
  assert.notEqual(withCookie.status, 307);

  const prefetch = await proxy(
    new NextRequest("http://localhost/dashboards", {
      headers: { ...navigation, "next-router-prefetch": "1" },
    }),
  );
  assert.notEqual(prefetch.status, 307);

  // A browser without Fetch Metadata still navigates with Accept: text/html.
  const oldBrowser = await proxy(
    new NextRequest("http://localhost/dashboards", {
      headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
    }),
  );
  assert.equal(oldBrowser.status, 307);

  // A cookie-less non-navigation would loop between the page and login, so it
  // gets the page: a health check, a script, Cloudflare's container probe.
  const probes: Record<string, string>[] = [
    {},
    { accept: "*/*" },
    { "sec-fetch-dest": "empty" },
  ];
  for (const headers of probes) {
    assert.notEqual(
      (await proxy(new NextRequest("http://localhost/", { headers }))).status,
      307,
      JSON.stringify(headers),
    );
  }

  // `/api` is outside the matcher, so API routes keep answering 401.
  const pattern = new RegExp(`^${proxyConfig.matcher[0]}$`);
  assert.equal(pattern.test("/api/dashboards"), false);
  assert.equal(pattern.test("/dashboards"), true);
});

test("the account page describes a demo visitor, not an identity provider", () => {
  const origin = accountOrigin("demo", "");
  assert.match(origin.profile, /demo visitor/);
  assert.match(origin.roles, /Every demo visitor gets the same role/);
  assert.doesNotMatch(origin.profile, /identity provider/);
  assert.match(accountOrigin("oidc", "").profile, /identity provider/);
});
