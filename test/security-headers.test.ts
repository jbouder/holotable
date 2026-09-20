import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contentSecurityPolicy,
  contentSecurityPolicyHeaderName,
  generateNonce,
  staticSecurityHeaders,
} from "@/lib/security-headers";

/** Split a policy into a map of directive name to its source list. */
function directives(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out.set(name, sources);
  }
  return out;
}

const keys = (production: boolean) =>
  staticSecurityHeaders({ production }).map((h) => h.key);

test("every response carries the static baseline", () => {
  for (const production of [true, false]) {
    const set = new Set(keys(production));
    for (const key of [
      "Referrer-Policy",
      "X-Content-Type-Options",
      "X-Frame-Options",
      "Permissions-Policy",
    ]) {
      assert.ok(set.has(key), `${key} missing (production=${production})`);
    }
  }
  const byKey = new Map(
    staticSecurityHeaders({ production: true }).map((h) => [h.key, h.value]),
  );
  assert.equal(byKey.get("X-Content-Type-Options"), "nosniff");
  assert.equal(byKey.get("X-Frame-Options"), "DENY");
  assert.equal(byKey.get("Referrer-Policy"), "strict-origin-when-cross-origin");
  for (const feature of ["camera", "microphone", "geolocation", "payment"]) {
    assert.match(byKey.get("Permissions-Policy") ?? "", new RegExp(`${feature}=\\(\\)`));
  }
});

test("HSTS is sent in production only", () => {
  assert.ok(keys(true).includes("Strict-Transport-Security"));
  assert.ok(!keys(false).includes("Strict-Transport-Security"));
  const hsts = staticSecurityHeaders({ production: true }).find(
    (h) => h.key === "Strict-Transport-Security",
  );
  assert.equal(hsts?.value, "max-age=31536000; includeSubDomains");
});

test("the nonce is fresh, base64, and long enough", () => {
  const a = generateNonce();
  const b = generateNonce();
  assert.notEqual(a, b);
  // 16 bytes → 24 base64 characters, the alphabet Next's nonce parser accepts.
  assert.match(a, /^[A-Za-z0-9+/]{22}==$/);
});

test("the policy locks scripts to this request's nonce and nothing else", () => {
  const nonce = generateNonce();
  const d = directives(contentSecurityPolicy({ nonce, development: false }));

  assert.deepEqual(d.get("default-src"), ["'self'"]);
  assert.deepEqual(d.get("script-src"), [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
  ]);
  assert.ok(
    !d.get("script-src")?.includes("'unsafe-inline'"),
    "inline scripts need the nonce",
  );
  assert.ok(!d.get("script-src")?.includes("'unsafe-eval'"), "no eval in production");

  assert.deepEqual(d.get("object-src"), ["'none'"]);
  assert.deepEqual(d.get("base-uri"), ["'self'"]);
  assert.deepEqual(d.get("form-action"), ["'self'"]);
  assert.deepEqual(d.get("frame-ancestors"), ["'none'"]);
  assert.deepEqual(d.get("connect-src"), ["'self'"]);
  assert.deepEqual(d.get("font-src"), ["'self'"]);
});

test("style elements need the nonce; style attributes are allowed", () => {
  const nonce = generateNonce();
  const d = directives(contentSecurityPolicy({ nonce, development: false }));
  // 'unsafe-inline' would be ignored next to a nonce, and the nonce cannot
  // cover React's server-rendered style="" attributes, hence the split.
  assert.deepEqual(d.get("style-src"), ["'self'", `'nonce-${nonce}'`]);
  assert.deepEqual(d.get("style-src-attr"), ["'unsafe-inline'"]);
});

test("development relaxes only eval and the hot-reload socket", () => {
  const nonce = generateNonce();
  const prod = directives(contentSecurityPolicy({ nonce, development: false }));
  const dev = directives(contentSecurityPolicy({ nonce, development: true }));

  assert.deepEqual(dev.get("script-src"), [
    ...(prod.get("script-src") ?? []),
    "'unsafe-eval'",
  ]);
  assert.deepEqual(dev.get("connect-src"), ["'self'", "ws:", "wss:"]);
  for (const [name, sources] of prod) {
    if (name === "script-src" || name === "connect-src") continue;
    assert.deepEqual(dev.get(name), sources, `${name} differs in development`);
  }
  assert.deepEqual([...dev.keys()], [...prod.keys()]);
});

test("the nonce lands where Next looks for it", () => {
  // Next extracts the nonce from `script-src` (falling back to `default-src`)
  // with /^'nonce-([A-Za-z0-9+/_-]+={0,2})'$/ over the whitespace-split sources.
  const nonce = generateNonce();
  const policy = contentSecurityPolicy({ nonce, development: false });
  const scriptSrc = policy
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("script-src"));
  assert.ok(scriptSrc);
  const found = scriptSrc
    .split(/\s+/)
    .slice(1)
    .map((s) => s.match(/^'nonce-([A-Za-z0-9+/_-]+={0,2})'$/)?.[1])
    .find(Boolean);
  assert.equal(found, nonce);
});

test("report-only mode switches the header name, not the policy", () => {
  assert.equal(contentSecurityPolicyHeaderName(false), "Content-Security-Policy");
  assert.equal(
    contentSecurityPolicyHeaderName(true),
    "Content-Security-Policy-Report-Only",
  );
});
