import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { proxy } from "@/proxy";

/*
 * With a realm, a page opened without a session goes straight to sign-in and
 * back, as demo mode always has; the sign-in card is for an expired or
 * invalid cookie and for someone who just signed out.
 */

const navigation = { "sec-fetch-dest": "document" };

test("a cookie-less page request goes to sign-in, carrying the page", async () => {
  assert.notEqual(config.authMode, "demo");
  const page = await proxy(
    new NextRequest("http://localhost/dashboards/abc?var-host=web-1", {
      headers: navigation,
    }),
  );
  assert.equal(page.status, 307);
  const location = new URL(page.headers.get("location") ?? "");
  assert.equal(location.pathname, "/api/auth/login");
  assert.equal(location.searchParams.get("next"), "/dashboards/abc?var-host=web-1");
  assert.equal(page.headers.get("cache-control"), "no-store");
});

test("someone who just signed out gets the card, not the realm", async () => {
  const signedOut = await proxy(
    new NextRequest("http://localhost/dashboards", {
      headers: { ...navigation, cookie: `${config.signedOutCookieName}=1` },
    }),
  );
  assert.notEqual(signedOut.status, 307);
});

test("a session cookie, a prefetch, a probe and an embed are left alone", async () => {
  const cases: Array<[string, Record<string, string>]> = [
    ["/dashboards", { ...navigation, cookie: `${config.sessionCookieName}=anything` }],
    ["/dashboards", { ...navigation, "next-router-prefetch": "1" }],
    ["/", { accept: "*/*" }],
    ["/embed/abc?token=x", navigation],
  ];
  for (const [path, headers] of cases) {
    const response = await proxy(new NextRequest(`http://localhost${path}`, { headers }));
    assert.notEqual(response.status, 307, `${path} ${JSON.stringify(headers)}`);
  }
});

test("sign-in comes back to next; sign-out sets the marker and sign-in clears it", () => {
  const read = (path: string) =>
    readFileSync(
      new URL(`../src/app/api/auth/${path}/route.ts`, import.meta.url),
      "utf8",
    );
  const login = read("login");
  assert.match(login, /safeNextPath\(/);
  assert.match(login, /oidcNextCookieName, next/);
  assert.match(login, /renewSession\(/);
  const callback = read("callback");
  assert.match(callback, /safeNextPath\(store\.get\(config\.oidcNextCookieName\)/);
  assert.match(callback, /store\.delete\(config\.signedOutCookieName\)/);
  assert.match(callback, /Location: next/);
  assert.match(read("logout"), /set\(config\.signedOutCookieName/);
});
