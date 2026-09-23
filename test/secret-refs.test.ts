import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SourceRecord } from "@/lib/registry";
import {
  GrantedSecretRef,
  SECRET_REF_PATTERN,
  fetchGrantedSecretRefs,
  grantedRefs,
  isGranted,
  parseSecretRefGrants,
  readinessIn,
  secretRefEnvVars,
} from "@/lib/secret-refs";
import {
  SecretRefError,
  grantedSecretRefStatus,
  hasCredentials,
  resolveCredentials,
  validateSecretsDir,
  validateSourceSecrets,
} from "@/lib/secrets/credentials";
import { refreshCatalog } from "@/lib/timescaledb/catalog";
import { executePlan } from "@/lib/timescaledb/client";

/**
 * `secret_ref` grants and resolution.
 *
 * The properties here are security properties rather than conveniences: a
 * ref resolves only in a workspace it is granted to, the absence of a
 * declaration grants nothing, what the UI is shown is the verdict execution
 * reaches, and nothing but names and booleans crosses the wire.
 */

const realFetch = globalThis.fetch;
const touched: string[] = [];
const dirs: string[] = [];
function setEnv(name: string, value: string | undefined): void {
  touched.push(name);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
function secretsDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "holotable-secrets-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const name of touched.splice(0)) delete process.env[name];
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  globalThis.fetch = realFetch;
});

function grants(raw: string) {
  const parsed = parseSecretRefGrants(raw);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  return parsed.grants;
}

/* --- The declaration ------------------------------------------------------ */

test("the env family is one function, so the lookup and the advice agree", () => {
  assert.deepEqual(secretRefEnvVars("TS_METRICS"), {
    username: "TS_METRICS_USERNAME",
    password: "TS_METRICS_PASSWORD",
  });
});

test("a declaration grants each ref to the workspaces it names, and no others", () => {
  const g = grants("TS_METRICS:demo,ops; BILLING_RO:finance\n SHARED_RO:*");
  assert.equal(isGranted(g, "TS_METRICS", "demo"), true);
  assert.equal(isGranted(g, "TS_METRICS", "ops"), true);
  assert.equal(isGranted(g, "TS_METRICS", "finance"), false);
  assert.equal(isGranted(g, "BILLING_RO", "finance"), true);
  assert.equal(isGranted(g, "BILLING_RO", "demo"), false);
  assert.equal(isGranted(g, "SHARED_RO", "anything"), true);
  assert.equal(isGranted(g, "UNDECLARED", "demo"), false);
  assert.deepEqual(grantedRefs(g, "demo"), ["SHARED_RO", "TS_METRICS"]);
});

test("an empty declaration is valid and grants nothing", () => {
  assert.deepEqual(grantedRefs(grants(""), "demo"), []);
  assert.deepEqual(grantedRefs(grants("  ;\n "), "demo"), []);
});

test("a declaration that could grant more or less than meant is refused", () => {
  for (const [raw, pattern] of [
    ["TS_METRICS", /no workspace list/],
    ["ts_metrics:demo", /not an UPPER_SNAKE/],
    ["TS_METRICS:demo;TS_METRICS:ops", /more than once/],
    ["TS_METRICS:*,demo", /mixes "\*"/],
    ["TS_METRICS:", /empty or malformed workspace/],
    ["TS_METRICS:demo,,ops", /empty or malformed workspace/],
    ["TS_METRICS:de mo", /empty or malformed workspace/],
  ] as const) {
    const parsed = parseSecretRefGrants(raw);
    assert.equal(parsed.ok, false, raw);
    assert.match(parsed.ok ? "" : parsed.error, pattern, raw);
  }
});

/* --- Resolution ----------------------------------------------------------- */

const envA = {
  SOURCE_SECRET_REFS: "HT_A:ws-a",
  HT_A_USERNAME: "ro_a",
  HT_A_PASSWORD: "pw_a",
};

test("a ref resolves in a workspace it is granted to", () => {
  assert.deepEqual(resolveCredentials("HT_A", "ws-a", envA), {
    username: "ro_a",
    password: "pw_a",
  });
});

test("another workspace cannot borrow a ref it is not granted, credentials or not", () => {
  assert.throws(
    () => resolveCredentials("HT_A", "ws-b", envA),
    (err: unknown) =>
      err instanceof SecretRefError &&
      /not granted to workspace "ws-b"/.test(err.message) &&
      /SOURCE_SECRET_REFS/.test(err.message) &&
      !err.message.includes("pw_a"),
  );
  assert.equal(hasCredentials("HT_A", "ws-b", envA), false);
});

test("no declaration grants nothing: the environment alone never resolves a ref", () => {
  const { SOURCE_SECRET_REFS: _unset, ...env } = envA;
  assert.throws(() => resolveCredentials("HT_A", "ws-a", env), /not granted/);
});

test("a malformed declaration fails closed rather than granting what it could parse", () => {
  const env = { ...envA, SOURCE_SECRET_REFS: "HT_A:ws-a;HT_A:ws-b" };
  assert.throws(() => resolveCredentials("HT_A", "ws-a", env), /not granted/);
});

test("readiness is the verdict the execution path would reach, not a second opinion", () => {
  const env: Record<string, string> = { SOURCE_SECRET_REFS: "HT_TEST:ws" };
  assert.equal(hasCredentials("HT_TEST", "ws", env), false);

  // A username with no password is what resolveCredentials refuses, so it is
  // what readiness must refuse too.
  env.HT_TEST_USERNAME = "ro";
  assert.equal(hasCredentials("HT_TEST", "ws", env), false);
  assert.throws(() => resolveCredentials("HT_TEST", "ws", env), /HT_TEST_PASSWORD/);

  // An empty password is a password: the resolver accepts it, so readiness does.
  env.HT_TEST_PASSWORD = "";
  assert.equal(hasCredentials("HT_TEST", "ws", env), true);
  assert.deepEqual(resolveCredentials("HT_TEST", "ws", env), {
    username: "ro",
    password: "",
  });
});

test("a malformed ref is unconfigured rather than a thrown 500", () => {
  const env = { SOURCE_SECRET_REFS: "", lower_USERNAME: "ro", lower_PASSWORD: "pw" };
  assert.equal(hasCredentials("lower", "ws", env), false);
  assert.equal(hasCredentials("TS METRICS", "ws", env), false);
  assert.equal(hasCredentials("", "ws", env), false);
});

test("a well-formed ref cannot report on an environment variable that is not a family", () => {
  // PATH is UPPER_SNAKE and always set, so neither the pattern nor a grant
  // keeps it out. What does is that only `_USERNAME`/`_PASSWORD` are read.
  assert.ok(SECRET_REF_PATTERN.test("PATH"));
  const env: Record<string, string | undefined> = {
    ...process.env,
    SOURCE_SECRET_REFS: "PATH:*",
  };
  assert.ok(env.PATH);
  assert.equal(hasCredentials("PATH", "ws", env), false);
});

/* --- Files ---------------------------------------------------------------- */

test("credentials written to SOURCE_SECRETS_DIR after start resolve with no restart", () => {
  const dir = secretsDir();
  const env = { SOURCE_SECRET_REFS: "HT_F:ws", SOURCE_SECRETS_DIR: dir };
  assert.equal(hasCredentials("HT_F", "ws", env), false);

  // What a kubelet refreshing a mounted Secret amounts to: new files, same
  // process, same environment.
  writeFileSync(path.join(dir, "HT_F_USERNAME"), "ro_f\n");
  writeFileSync(path.join(dir, "HT_F_PASSWORD"), "pw_f\n");
  assert.deepEqual(resolveCredentials("HT_F", "ws", env), {
    username: "ro_f",
    password: "pw_f",
  });

  // And a rotation is picked up the same way.
  writeFileSync(path.join(dir, "HT_F_PASSWORD"), "pw_f2");
  assert.equal(resolveCredentials("HT_F", "ws", env).password, "pw_f2");
});

test("files win over the environment, which stays the fallback", () => {
  const dir = secretsDir();
  const env = { ...envA, SOURCE_SECRETS_DIR: dir };
  assert.equal(resolveCredentials("HT_A", "ws-a", env).username, "ro_a");

  writeFileSync(path.join(dir, "HT_A_USERNAME"), "ro_file");
  writeFileSync(path.join(dir, "HT_A_PASSWORD"), "pw_file");
  assert.deepEqual(resolveCredentials("HT_A", "ws-a", env), {
    username: "ro_file",
    password: "pw_file",
  });
});

test("half a pair of files is refused rather than completed from the environment", () => {
  const dir = secretsDir();
  writeFileSync(path.join(dir, "HT_A_USERNAME"), "ro_file");
  const env = { ...envA, SOURCE_SECRETS_DIR: dir };
  assert.throws(
    () => resolveCredentials("HT_A", "ws-a", env),
    /incomplete in SOURCE_SECRETS_DIR/,
  );
});

test("a file does not make an ungranted ref resolve", () => {
  const dir = secretsDir();
  writeFileSync(path.join(dir, "HT_A_USERNAME"), "ro_file");
  writeFileSync(path.join(dir, "HT_A_PASSWORD"), "pw_file");
  const env = { ...envA, SOURCE_SECRETS_DIR: dir };
  assert.throws(() => resolveCredentials("HT_A", "ws-b", env), /not granted/);
});

test("a SOURCE_SECRETS_DIR that is not a directory is reported, not fatal", () => {
  assert.deepEqual(validateSecretsDir({}), []);
  assert.deepEqual(validateSecretsDir({ SOURCE_SECRETS_DIR: secretsDir() }), []);
  const problems = validateSecretsDir({ SOURCE_SECRETS_DIR: "/nonexistent/holotable" });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].severity, "warning");
  assert.equal(problems[0].variable, "SOURCE_SECRETS_DIR");
});

/* --- Every place credentials are used ------------------------------------ */

function sourceIn(workspaceId: string, secretRef: string): SourceRecord {
  return {
    id: "src",
    workspaceId,
    name: "src",
    kind: "timescaledb",
    // A port nothing listens on: a check that let the ref through would fail
    // with a connection error instead, and the assertion would say so.
    config: {
      host: "127.0.0.1",
      port: 1,
      database: "db",
      schema: "public",
      ssl: false,
      tables: [{ name: "t", columns: [{ name: "c", type: "int" }] }],
    },
    secretRef,
    catalogRefreshedAt: null,
    catalogMissingTables: [],
    createdBy: "test",
    createdAt: "",
    updatedAt: "",
    tombstonedAt: null,
  };
}

test("execution and refresh refuse an ungranted ref even from a record written directly", async () => {
  for (const [name, value] of Object.entries(envA)) setEnv(name, value);
  const stolen = sourceIn("ws-b", "HT_A");

  await assert.rejects(
    executePlan(stolen, { sql: "SELECT 1", params: [] }),
    /not granted/,
  );
  await assert.rejects(refreshCatalog(stolen), /not granted/);
});

/* --- What crosses the wire ------------------------------------------------ */

test("the list names only the workspace's granted refs, each with a boolean", () => {
  const env = {
    SOURCE_SECRET_REFS: "HT_A:ws-a; HT_B:ws-b; HT_ALL:*",
    HT_A_USERNAME: "ro",
    HT_A_PASSWORD: "pw",
    HT_B_USERNAME: "ro",
    HT_B_PASSWORD: "pw",
  };
  assert.deepEqual(grantedSecretRefStatus("ws-a", env), [
    { ref: "HT_A", configured: true },
    { ref: "HT_ALL", configured: false },
  ]);
  assert.deepEqual(grantedSecretRefStatus("ws-c", env), [
    { ref: "HT_ALL", configured: false },
  ]);
});

test("an entry is a ref and a boolean, and nothing that came from a secret", () => {
  assert.equal(
    GrantedSecretRef.safeParse({ ref: "TS_METRICS", configured: true }).success,
    true,
  );
  // A field smuggled alongside the boolean is refused outright rather than
  // silently ignored, so a careless server change fails loudly here.
  assert.equal(
    GrantedSecretRef.safeParse({ ref: "TS_METRICS", configured: true, username: "ro" })
      .success,
    false,
  );
});

test("readiness distinguishes not granted, no credentials and ready", () => {
  const list = {
    state: "ready" as const,
    refs: [
      { ref: "TS_METRICS", configured: true },
      { ref: "BILLING_RO", configured: false },
    ],
  };
  assert.deepEqual(readinessIn(list, "TS_METRICS"), {
    state: "configured",
    ref: "TS_METRICS",
  });

  const missing = readinessIn(list, "BILLING_RO");
  assert.equal(missing.state, "missing");
  assert.match(
    missing.state === "missing" ? missing.message : "",
    /BILLING_RO_USERNAME.*BILLING_RO_PASSWORD/,
  );

  const notGranted = readinessIn(list, "OTHER_RO");
  assert.equal(notGranted.state, "not-granted");
  assert.match(
    notGranted.state === "not-granted" ? notGranted.message : "",
    /SOURCE_SECRET_REFS/,
  );

  assert.deepEqual(readinessIn({ state: "loading" }, "TS_METRICS"), {
    state: "checking",
  });
});

test("the list is asked for by the workspace it is authorized against", async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (input: string) => {
    seen.push(String(input));
    return new Response(
      JSON.stringify({ refs: [{ ref: "TS_METRICS", configured: false }] }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  const outcome = await fetchGrantedSecretRefs("ws 1");

  assert.deepEqual(seen, ["/api/secret-refs?workspaceId=ws%201"]);
  assert.deepEqual(outcome, {
    ok: true,
    refs: [{ ref: "TS_METRICS", configured: false }],
  });
});

test("a body that is not a list is a failure, not an empty list", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ refs: [{ ref: "TS_METRICS", configured: "maybe" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  const outcome = await fetchGrantedSecretRefs("ws-1");
  assert.equal(outcome.ok, false);
});

/* --- Startup -------------------------------------------------------------- */

test("startup warns about sources whose ref is not granted, or does not resolve", () => {
  const problems = validateSourceSecrets(
    [
      { secretRef: "HT_A", workspaceId: "ws-a" },
      { secretRef: "HT_A", workspaceId: "ws-a" },
      { secretRef: "HT_A", workspaceId: "ws-b" },
      { secretRef: "HT_C", workspaceId: "ws-a" },
    ],
    { ...envA, SOURCE_SECRET_REFS: "HT_A:ws-a; HT_C:*" },
  );
  assert.deepEqual(
    problems.map((p) => [p.variable, p.severity]),
    [
      ["SOURCE_SECRET_REFS", "warning"],
      ["HT_C_USERNAME", "warning"],
    ],
  );
  assert.match(problems[0].message, /"HT_A" to workspace "ws-b"/);
  assert.match(problems[1].message, /HT_C_USERNAME and HT_C_PASSWORD/);
});
