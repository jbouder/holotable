import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { checkOrigin, isOrigin, publicOrigin } from "@/lib/auth/origin";
import { cookieNames } from "@/lib/config";
import { route } from "@/lib/http";

/*
 * #25: the same-origin check on state-changing requests, and #26: the
 * `__Host-` / `__Secure-` cookie prefixes.
 */

const URL_ = "http://localhost:3000/api/dashboards";
const SELF = "http://localhost:3000";

function verdict(
  headers: Record<string, string>,
  { method = "POST", url = URL_, allowed = [] as string[] } = {},
) {
  return checkOrigin(method, url, new Headers(headers), allowed);
}

/* -------------------------------------------------------------------------- */
/* The rule                                                                   */
/* -------------------------------------------------------------------------- */

test("a read is never checked", () => {
  for (const method of ["GET", "HEAD", "OPTIONS", "get"]) {
    assert.deepEqual(
      verdict(
        { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
        { method },
      ),
      { ok: true },
    );
  }
});

test("the browser's own word: our page, or the person acting directly", () => {
  assert.deepEqual(verdict({ "sec-fetch-site": "same-origin", origin: SELF }), {
    ok: true,
  });
  assert.deepEqual(verdict({ "sec-fetch-site": "none" }), { ok: true });
});

test("another site's page is refused, whatever its method", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"]) {
    assert.deepEqual(
      verdict(
        { "sec-fetch-site": "cross-site", origin: "https://evil.example" },
        { method },
      ),
      { ok: false, reason: "cross-site" },
    );
  }
});

test("a sibling subdomain is refused too, which SameSite=Lax would let through", () => {
  assert.deepEqual(
    verdict(
      { "sec-fetch-site": "same-site", origin: "https://blog.example.com" },
      { url: "https://holotable.example.com/api/query" },
    ),
    { ok: false, reason: "cross-site" },
  );
});

test("an opaque origin is refused", () => {
  assert.deepEqual(verdict({ origin: "null" }), { ok: false, reason: "opaque-origin" });
  assert.deepEqual(verdict({ origin: "null", "sec-fetch-site": "cross-site" }), {
    ok: false,
    reason: "opaque-origin",
  });
});

test("cross-site with no Origin to check is refused", () => {
  assert.deepEqual(verdict({ "sec-fetch-site": "cross-site" }), {
    ok: false,
    reason: "cross-site",
  });
});

test("without Fetch Metadata, Origin must be the origin the request was sent to", () => {
  assert.deepEqual(verdict({ origin: SELF }), { ok: true });
  assert.deepEqual(verdict({ origin: "https://evil.example" }), {
    ok: false,
    reason: "foreign-origin",
  });
  // Same host, other port: another origin.
  assert.deepEqual(verdict({ origin: "http://localhost:4000" }), {
    ok: false,
    reason: "foreign-origin",
  });
});

test("behind a proxy the forwarded host and scheme are the origin addressed", () => {
  const internal = "http://10.0.0.7:3000/api/query";
  const forwarded = {
    "x-forwarded-host": "holotable.example.com",
    "x-forwarded-proto": "https",
  };
  assert.deepEqual(
    verdict({ ...forwarded, origin: "https://holotable.example.com" }, { url: internal }),
    { ok: true },
  );
  assert.deepEqual(
    verdict(
      { host: "holotable.example.com", origin: "http://holotable.example.com" },
      {
        url: internal,
      },
    ),
    { ok: true },
  );
  assert.deepEqual(
    verdict({ ...forwarded, origin: "https://evil.example" }, { url: internal }),
    { ok: false, reason: "foreign-origin" },
  );
});

test("a request no page sent, with neither header, is left to authentication", () => {
  // curl, a script, the realm's back-channel logout.
  assert.deepEqual(verdict({}), { ok: true });
});

test("ALLOWED_ORIGINS admits exactly the origins it names", () => {
  const allowed = ["https://grafana.example.com"];
  assert.deepEqual(
    verdict(
      { "sec-fetch-site": "cross-site", origin: "https://grafana.example.com" },
      { allowed },
    ),
    { ok: true },
  );
  assert.deepEqual(
    verdict(
      {
        "sec-fetch-site": "cross-site",
        origin: "https://grafana.example.com.evil.example",
      },
      { allowed },
    ),
    { ok: false, reason: "cross-site" },
  );
});

test("publicOrigin falls back to the request URL", () => {
  assert.equal(publicOrigin(new Headers(), new URL(URL_)), SELF);
  assert.equal(
    publicOrigin(new Headers({ "x-forwarded-proto": "gopher" }), new URL(URL_)),
    SELF,
    "an unknown scheme is ignored",
  );
});

test("an allowed origin is an origin and nothing more", () => {
  assert.equal(isOrigin("https://grafana.example.com"), true);
  assert.equal(isOrigin("http://localhost:8080"), true);
  assert.equal(isOrigin("https://grafana.example.com/"), false);
  assert.equal(isOrigin("https://grafana.example.com/path"), false);
  assert.equal(isOrigin("grafana.example.com"), false);
  assert.equal(isOrigin("ftp://grafana.example.com"), false);
  assert.equal(isOrigin("*"), false);
});

/* -------------------------------------------------------------------------- */
/* Enforced in route(), before the handler                                    */
/* -------------------------------------------------------------------------- */

test("a cross-origin POST is refused before the handler runs", async () => {
  let ran = 0;
  const handler = route("test.mutate", async () => {
    ran++;
    return new Response("ok");
  });
  const post = (headers: Record<string, string>) =>
    handler(new Request(URL_, { method: "POST", headers }));

  const refused = await post({
    origin: "https://evil.example",
    "sec-fetch-site": "cross-site",
  });
  assert.equal(refused.status, 403);
  assert.match(await refused.text(), /cross-origin request rejected/);
  assert.ok(refused.headers.get("x-request-id"));
  assert.equal(ran, 0);

  assert.equal(
    (await post({ origin: SELF, "sec-fetch-site": "same-origin" })).status,
    200,
  );
  assert.equal((await post({ "sec-fetch-site": "none" })).status, 200);
  assert.equal((await post({ origin: SELF })).status, 200);
  assert.equal(ran, 3);
});

/** Every `route.ts` under `src/app/api`. */
function routeFiles(dir = join(process.cwd(), "src/app/api")): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return entry === "route.ts" ? [path] : [];
  });
}

test("every state-changing route goes through route(), so none skips the check", () => {
  const mutating: string[] = [];
  for (const file of routeFiles()) {
    const text = readFileSync(file, "utf8");
    for (const [, method, rest] of text.matchAll(
      /export\s+(?:const|async\s+function|function)\s+(POST|PUT|PATCH|DELETE)\b(.{0,12})/g,
    )) {
      const where = `${relative(process.cwd(), file)} ${method}`;
      assert.match(rest, /^\s*=\s*route\(/, `${where} is not wrapped in route()`);
      mutating.push(where);
    }
  }
  // The sweep found something, so a change to the export style cannot make
  // it pass vacuously.
  assert.ok(mutating.length > 20, `only ${mutating.length} mutating handlers found`);
});

/* -------------------------------------------------------------------------- */
/* Cookie prefixes (#26)                                                      */
/* -------------------------------------------------------------------------- */

test("a Secure cookie carries the prefix the browser enforces", () => {
  assert.deepEqual(cookieNames("holotable_session", true), {
    session: "__Host-holotable_session",
    // Scoped to /api/auth, which __Host- forbids.
    renew: "__Secure-holotable_session_renew",
    oidcState: "__Host-holotable_oidc_state",
    oidcNonce: "__Host-holotable_oidc_nonce",
    oidcVerifier: "__Host-holotable_oidc_verifier",
  });
});

test("without Secure the names stay bare, so plain-HTTP sign-in still works", () => {
  assert.deepEqual(cookieNames("holotable_session", false), {
    session: "holotable_session",
    renew: "holotable_session_renew",
    oidcState: "holotable_oidc_state",
    oidcNonce: "holotable_oidc_nonce",
    oidcVerifier: "holotable_oidc_verifier",
  });
});

test("a __Host- cookie is set with Path=/ and never a Domain", () => {
  // The browser drops a __Host- cookie that breaks either rule, which would
  // sign everyone out rather than fail loudly.
  for (const file of ["src/lib/auth/cookie.ts", "src/app/api/auth/login/route.ts"]) {
    const text = readFileSync(join(process.cwd(), file), "utf8");
    assert.doesNotMatch(text, /\bdomain\s*:/i, `${file} sets a Domain`);
  }
  const cookie = readFileSync(join(process.cwd(), "src/lib/auth/cookie.ts"), "utf8");
  const session = cookie.slice(cookie.indexOf("export async function setSessionCookie"));
  assert.match(session.slice(0, session.indexOf("\n}")), /path: "\/"/);
  const login = readFileSync(
    join(process.cwd(), "src/app/api/auth/login/route.ts"),
    "utf8",
  );
  assert.match(login, /path: "\/"/);
});
