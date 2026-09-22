import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { hasCredentials, resolveCredentials } from "@/lib/registry";
import {
  SECRET_REF_PATTERN,
  SecretRefStatus,
  fetchSecretRefStatus,
  readinessFor,
  readinessFromStatus,
  secretRefEnvVars,
} from "@/lib/secret-refs";

/**
 * `secret_ref` readiness.
 *
 * Two properties matter here and both are security properties rather than
 * conveniences: the readiness a user is shown is the *same* verdict the
 * execution path will reach, and nothing but a boolean ever crosses the wire.
 */

const touched: string[] = [];
function setEnv(name: string, value: string | undefined): void {
  touched.push(name);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  for (const name of touched.splice(0)) delete process.env[name];
  globalThis.fetch = realFetch;
});

test("the env family is one function, so the lookup and the advice agree", () => {
  assert.deepEqual(secretRefEnvVars("TS_METRICS"), {
    username: "TS_METRICS_USERNAME",
    password: "TS_METRICS_PASSWORD",
  });
});

test("readiness is the verdict the execution path would reach, not a second opinion", () => {
  assert.equal(hasCredentials("HT_TEST"), false);

  // A username with no password is what resolveCredentials refuses, so it is
  // what readiness must refuse too.
  setEnv("HT_TEST_USERNAME", "ro");
  assert.equal(hasCredentials("HT_TEST"), false);
  assert.throws(() => resolveCredentials("HT_TEST"));

  // An empty password is a password: the resolver accepts it, so readiness does.
  setEnv("HT_TEST_PASSWORD", "");
  assert.equal(hasCredentials("HT_TEST"), true);
  assert.deepEqual(resolveCredentials("HT_TEST"), { username: "ro", password: "" });
});

test("a malformed ref is unconfigured rather than a thrown 500", () => {
  setEnv("lower_USERNAME", "ro");
  setEnv("lower_PASSWORD", "pw");
  assert.equal(hasCredentials("lower"), false);
  assert.equal(hasCredentials("TS METRICS"), false);
  assert.equal(hasCredentials(""), false);
});

test("a well-formed ref cannot report on an environment variable that is not a family", () => {
  // PATH is UPPER_SNAKE and is always set, so the pattern alone does not keep
  // it out. What does is that only `_USERNAME`/`_PASSWORD` are ever read: the
  // answer for PATH is false, and it says nothing about PATH itself.
  assert.ok(SECRET_REF_PATTERN.test("PATH"));
  assert.ok(process.env.PATH);
  assert.equal(hasCredentials("PATH"), false);
});

test("an empty ref is idle, a misspelled one is settled without asking the server", () => {
  assert.deepEqual(readinessFor("   "), { state: "idle" });
  assert.equal(readinessFor("ts_metrics").state, "invalid");
  assert.deepEqual(readinessFor("TS_METRICS"), { state: "checking" });
});

test("a missing ref is reported with the two variables to set", () => {
  const readiness = readinessFromStatus({ ref: "TS_METRICS", configured: false });
  assert.equal(readiness.state, "missing");
  assert.match(
    readiness.state === "missing" ? readiness.message : "",
    /TS_METRICS_USERNAME.*TS_METRICS_PASSWORD/,
  );
  assert.deepEqual(readinessFromStatus({ ref: "TS_METRICS", configured: true }), {
    state: "configured",
    ref: "TS_METRICS",
  });
});

test("the status body is a boolean and a ref, and nothing that came from a secret", () => {
  assert.equal(
    SecretRefStatus.safeParse({ ref: "TS_METRICS", configured: true }).success,
    true,
  );
  // A field smuggled alongside the boolean is refused outright rather than
  // silently ignored, so a careless server change fails loudly here.
  assert.equal(
    SecretRefStatus.safeParse({
      ref: "TS_METRICS",
      configured: true,
      username: "ro",
    }).success,
    false,
  );
});

test("the check names the ref in the path and the workspace it is authorized against", async () => {
  const seen: { url: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    seen.push({ url: String(input), body: init?.body });
    return new Response(JSON.stringify({ ref: "TS_METRICS", configured: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const outcome = await fetchSecretRefStatus({
    workspaceId: "ws 1",
    secretRef: "TS_METRICS",
  });

  assert.deepEqual(seen, [
    {
      url: "/api/secret-refs/TS_METRICS/status?workspaceId=ws%201",
      body: undefined,
    },
  ]);
  assert.deepEqual(outcome, {
    ok: true,
    status: { ref: "TS_METRICS", configured: false },
  });
});

test("a body that is not a status is a failure, not a false negative", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ configured: "maybe" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  const outcome = await fetchSecretRefStatus({
    workspaceId: "ws-1",
    secretRef: "TS_METRICS",
  });
  assert.equal(outcome.ok, false);
});
