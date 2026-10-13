import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { LookupAddress } from "node:dns";
import { APICallError } from "ai";
import {
  baseUrlShapeProblem,
  invalidAllowlistEntries,
  isNonPublicAddress,
  parseBaseUrlAllowlist,
} from "@/lib/ai/base-url";
import {
  BaseUrlRefusedError,
  baseUrlRefusal,
  checkBaseUrl,
  guardedFetch,
  guardedLookup,
} from "@/lib/ai/guarded-fetch";
import { isRetryable } from "@/lib/ai/invoke";
import { generationRow } from "@/lib/ai/log";
import {
  describeKey,
  inputFromDraft,
  keyHint,
  type ModelConfigInput,
} from "@/lib/ai/model-config";
import {
  configView,
  type ModelResolutionDeps,
  openCredentials,
  prepareWrite,
  sealCredentials,
} from "@/lib/ai/model-resolution";
import { workspaceModelView } from "@/lib/ai/model-admin";
import { resolveModel } from "@/lib/ai/models";
import { providerErrorMessage } from "@/lib/ai/provider-error";
import { PROVIDER_KIND_NAMES, providerKind } from "@/lib/ai/providers/registry";
import { auditRow } from "@/lib/audit";
import { parseGroups } from "@/lib/auth/claims";
import { sealRefreshToken } from "@/lib/auth/refresh-token";
import type { StoredModel } from "@/lib/db/models";
import { memoryModelStore, storedModel } from "./support/models";
import { redactString, rememberSecret } from "@/lib/log";
import { openSecret, sealSecret } from "@/lib/secrets/seal";

const SECRET = new TextEncoder().encode("s".repeat(40));
const OTHER = new TextEncoder().encode("o".repeat(40));
const NO_ALLOWLIST = parseBaseUrlAllowlist("");

/* -------------------------------------------------------------------------- */
/* Sealing                                                                    */
/* -------------------------------------------------------------------------- */

test("a sealed value opens under its own label and secret, and nothing else", () => {
  const sealed = sealSecret("value", "label a", SECRET);
  assert.equal(openSecret(sealed, "label a", SECRET), "value");
  assert.equal(openSecret(sealed, "label b", SECRET), null);
  assert.equal(openSecret(sealed, "label a", OTHER), null);
  const edited = Buffer.from(sealed);
  edited[edited.length - 1] ^= 1;
  assert.equal(openSecret(edited, "label a", SECRET), null);
});

test("a refresh token never opens as a model key: each use has its own label", () => {
  const token = sealRefreshToken("rt-1", SECRET);
  assert.deepEqual(openCredentials(token, SECRET), { state: "unreadable" });
});

test("a model key sealed before SESSION_SECRET rotated reads as unreadable, not as a crash", () => {
  const sealed = sealCredentials({ apiKey: "sk-old-key-0000000000" }, OTHER);
  assert.deepEqual(openCredentials(sealed, SECRET), { state: "unreadable" });
  assert.deepEqual(openCredentials(null, SECRET), { state: "none" });
});

/* -------------------------------------------------------------------------- */
/* The base URL guard                                                         */
/* -------------------------------------------------------------------------- */

test("non-public addresses are recognized, IPv4, IPv6 and IPv4-mapped", () => {
  for (const address of [
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "127.0.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "::ffff:10.0.0.1",
    "::ffff:169.254.169.254",
    "64:ff9b::a00:1",
    "not-an-address",
  ]) {
    assert.equal(isNonPublicAddress(address), true, address);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
    assert.equal(isNonPublicAddress(address), false, address);
  }
});

test("a base URL must be https, credential-free and not a non-public literal", () => {
  assert.equal(baseUrlShapeProblem("https://openrouter.ai/api/v1", NO_ALLOWLIST), null);
  assert.match(
    baseUrlShapeProblem("http://openrouter.ai/api/v1", NO_ALLOWLIST) ?? "",
    /must use https/,
  );
  assert.match(baseUrlShapeProblem("ftp://x.example", NO_ALLOWLIST) ?? "", /https/);
  assert.match(
    baseUrlShapeProblem("https://user:pw@api.example.com/v1", NO_ALLOWLIST) ?? "",
    /user name or password/,
  );
  for (const url of [
    "https://169.254.169.254/latest",
    "https://127.0.0.1/v1",
    "https://[::1]/v1",
    "https://[::ffff:10.0.0.1]/v1",
    // The URL parser normalizes the shorthand forms to the dotted address.
    "https://2130706433/v1",
    "https://0x7f.1/v1",
  ]) {
    assert.match(
      baseUrlShapeProblem(url, NO_ALLOWLIST) ?? "",
      /not a public address/,
      url,
    );
  }
});

test("the operator's allowlist admits plain http and non-public addresses, and only those", () => {
  const allowlist = parseBaseUrlAllowlist("ollama.internal, 10.20.0.0/16");
  assert.equal(baseUrlShapeProblem("http://ollama.internal:11434/v1", allowlist), null);
  assert.equal(baseUrlShapeProblem("http://10.20.1.5:8000/v1", allowlist), null);
  assert.match(baseUrlShapeProblem("http://10.21.1.5/v1", allowlist) ?? "", /https/);
  assert.match(
    baseUrlShapeProblem("https://10.21.1.5/v1", allowlist) ?? "",
    /not a public address/,
  );
  assert.deepEqual(invalidAllowlistEntries("ollama.internal, 10.0.0.0/8, ::1"), []);
  assert.deepEqual(invalidAllowlistEntries("http://x, a_b, 10.0.0.0/99"), [
    "http://x",
    "a_b",
    "10.0.0.0/99",
  ]);
});

/** A resolver that answers from a table, the way `dns.lookup` with `all` does. */
function fakeResolve(table: Record<string, string[]>) {
  return (
    hostname: string,
    _options: unknown,
    callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
  ) => {
    const addresses = table[hostname];
    if (!addresses) {
      const err: NodeJS.ErrnoException = new Error("not found");
      err.code = "ENOTFOUND";
      return callback(err, []);
    }
    callback(
      null,
      addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
    );
  };
}

const lookupWith = (
  allowlist: ReturnType<typeof parseBaseUrlAllowlist>,
  table: Record<string, string[]>,
  host: string,
  all: boolean,
) =>
  new Promise<{ err: NodeJS.ErrnoException | null; address: unknown }>((done) =>
    guardedLookup(allowlist, fakeResolve(table))(host, { all }, (err, address) =>
      done({ err, address }),
    ),
  );

test("every connection refuses a name that resolves to a non-public address (DNS rebinding)", async () => {
  const table = {
    "api.example.com": ["93.184.216.34"],
    "rebind.example.com": ["93.184.216.34", "169.254.169.254"],
    "ollama.internal": ["10.20.0.5"],
  };
  const ok = await lookupWith(NO_ALLOWLIST, table, "api.example.com", false);
  assert.equal(ok.err, null);
  assert.equal(ok.address, "93.184.216.34");
  const all = await lookupWith(NO_ALLOWLIST, table, "api.example.com", true);
  assert.deepEqual(all.address, [{ address: "93.184.216.34", family: 4 }]);

  // One bad record is enough: the connection could be steered to it.
  const rebound = await lookupWith(NO_ALLOWLIST, table, "rebind.example.com", true);
  assert.ok(rebound.err instanceof BaseUrlRefusedError);
  assert.match(rebound.err.message, /169\.254\.169\.254/);

  const internal = await lookupWith(NO_ALLOWLIST, table, "ollama.internal", false);
  assert.ok(internal.err instanceof BaseUrlRefusedError);
  const allowed = await lookupWith(
    parseBaseUrlAllowlist("ollama.internal"),
    table,
    "ollama.internal",
    false,
  );
  assert.equal(allowed.err, null);
  const byRange = await lookupWith(
    parseBaseUrlAllowlist("10.20.0.0/16"),
    table,
    "ollama.internal",
    false,
  );
  assert.equal(byRange.err, null);
});

test("checkBaseUrl resolves the name before a configuration is saved", async () => {
  const resolve = fakeResolve({
    "api.example.com": ["93.184.216.34"],
    "internal.example.com": ["192.168.0.10"],
  });
  assert.equal(
    await checkBaseUrl("https://api.example.com/v1", NO_ALLOWLIST, resolve),
    null,
  );
  assert.match(
    (await checkBaseUrl("https://internal.example.com/v1", NO_ALLOWLIST, resolve)) ?? "",
    /192\.168\.0\.10.*AI_BASE_URL_ALLOWLIST/,
  );
  assert.match(
    (await checkBaseUrl("https://nowhere.example.com/v1", NO_ALLOWLIST, resolve)) ?? "",
    /could not be resolved \(ENOTFOUND\)/,
  );
  assert.match(
    (await checkBaseUrl("http://api.example.com/v1", NO_ALLOWLIST, resolve)) ?? "",
    /https/,
  );
});

async function withServer(
  handler: Parameters<typeof createServer>[1],
  run: (origin: string) => Promise<void>,
) {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("the guarded fetch reaches its own origin and refuses redirects and other origins", async () => {
  const allowlist = parseBaseUrlAllowlist("127.0.0.1");
  await withServer(
    (req, res) => {
      if (req.url === "/v1/redirect") {
        res.writeHead(302, { location: "http://169.254.169.254/" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ path: req.url }));
    },
    async (origin) => {
      const fetch = guardedFetch(`${origin}/v1`, allowlist);
      const res = await fetch(`${origin}/v1/models`);
      assert.deepEqual(await res.json(), { path: "/v1/models" });

      await assert.rejects(fetch(`${origin}/v1/redirect`), BaseUrlRefusedError);
      await assert.rejects(fetch("http://127.0.0.2/v1/models"), /not the configured/);
      // Without the allowlist entry the same literal address is refused.
      await assert.rejects(
        guardedFetch(`${origin}/v1`, NO_ALLOWLIST)(`${origin}/v1/models`),
        BaseUrlRefusedError,
      );
    },
  );
});

test("a refused connection is not retried, and says why in its own words", () => {
  const refused = new BaseUrlRefusedError(
    "x.example resolves to 10.0.0.1, which is not public",
  );
  const wrapped = new APICallError({
    message: "Cannot connect to API: fetch failed",
    url: "https://x.example/v1/responses",
    requestBodyValues: {},
    isRetryable: true,
    cause: new TypeError("fetch failed", { cause: refused }),
  });
  assert.equal(baseUrlRefusal(wrapped), refused);
  assert.equal(isRetryable(wrapped), false);
  assert.equal(providerErrorMessage(wrapped), refused.message);
});

/* -------------------------------------------------------------------------- */
/* Resolution                                                                 */
/* -------------------------------------------------------------------------- */

function stored(overrides: Partial<StoredModel> & { model?: string } = {}): StoredModel {
  const { model = "ws-model", ...rest } = overrides;
  return storedModel({
    settings: { baseUrl: "https://api.example.com/v1", model, api: "chat" },
    credentials: sealCredentials({ apiKey: "sk-workspace-key-0123456789" }),
    ...rest,
  });
}

/**
 * The 017 shapes as the catalog holds them after 022's data move: the
 * workspace's slot is a workspace model and its default, the person's slot a
 * personal model.
 */
function deps(
  rows: {
    workspace?: { allowPersonalKeys: boolean; config: StoredModel | null } | null;
    user?: StoredModel | null;
  },
  overrides: Partial<ModelResolutionDeps> = {},
): ModelResolutionDeps {
  const models = [
    ...(rows.workspace?.config ? [rows.workspace.config] : []),
    ...(rows.user
      ? [
          {
            ...rows.user,
            scope: "personal" as const,
            workspaceId: null,
            userSub: "alice",
          },
        ]
      : []),
  ];
  return {
    store: memoryModelStore({
      models,
      workspaces: rows.workspace
        ? [
            {
              workspaceId: "w",
              defaultModel: rows.workspace.config?.id ?? null,
              allowPersonalKeys: rows.workspace.allowPersonalKeys,
            },
          ]
        : [],
    }),
    demo: false,
    env: {},
    allowlist: NO_ALLOWLIST,
    ...overrides,
  };
}

const alice = parseGroups("alice", ["/workspaces/w/editor"]);
const input = { identity: alice, workspaceId: "w" };
const workspaceRow = (
  allowPersonalKeys: boolean,
  config: StoredModel | null = stored(),
) => ({
  config,
  allowPersonalKeys,
});
const personal = stored({ model: "my-model", updatedBy: "alice" });

test("with nothing configured in the app, the environment answers exactly as before", async () => {
  const missing = await resolveModel(input, deps({}));
  assert.deepEqual(missing, {
    ok: false,
    id: "env:default",
    source: "environment",
    problem:
      "No model configured. Set AI_MODEL and OPENAI_API_KEY on the server to generate with AI.",
  });
  const previous = process.env.AI_PROVIDER;
  process.env.AI_PROVIDER = "stub";
  try {
    const stub = await resolveModel(input, deps({}, { env: { AI_PROVIDER: "stub" } }));
    assert.equal(stub.ok, true);
    assert.equal(stub.source, "environment");
  } finally {
    if (previous === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = previous;
  }
});

test("a workspace model takes the place of the environment's", async () => {
  const resolved = await resolveModel(input, deps({ workspace: workspaceRow(false) }));
  assert.equal(resolved.ok, true);
  assert.equal(resolved.source, "workspace");
  assert.equal(resolved.ok && resolved.modelId, "ws-model");
});

test("a personal model is used only where the workspace allows personal keys", async () => {
  const ignored = await resolveModel(
    input,
    deps({ workspace: workspaceRow(false), user: personal }),
  );
  assert.equal(ignored.source, "workspace");

  const used = await resolveModel(
    input,
    deps({ workspace: workspaceRow(true), user: personal }),
  );
  assert.equal(used.source, "personal");
  assert.equal(used.ok && used.modelId, "my-model");

  // Allowed, with no workspace model of its own: personal, else environment.
  const envFallback = await resolveModel(
    input,
    deps({ workspace: { config: null, allowPersonalKeys: true } }),
  );
  assert.equal(envFallback.source, "environment");
});

test("demo mode turns both levels off", async () => {
  const resolved = await resolveModel(
    input,
    deps({ workspace: workspaceRow(true), user: personal }, { demo: true }),
  );
  assert.equal(resolved.source, "environment");
});

test("a key that can no longer be read is reported, never replaced by the next level", async () => {
  const rotated = stored({ credentials: sealCredentials({ apiKey: "sk-old" }, OTHER) });
  const resolved = await resolveModel(
    input,
    deps({ workspace: workspaceRow(false, rotated) }),
  );
  assert.equal(resolved.ok, false);
  assert.equal(resolved.source, "workspace");
  assert.match(!resolved.ok ? resolved.problem : "", /enter it again/);

  const mine = await resolveModel(
    input,
    deps({
      workspace: workspaceRow(true),
      user: { ...personal, credentials: rotated.credentials },
    }),
  );
  assert.equal(mine.source, "personal");
  assert.match(!mine.ok ? mine.problem : "", /Your personal model .* on the Models page/);
});

test("a stored configuration that no longer parses is reported, not thrown", async () => {
  const broken = stored({ settings: { baseUrl: "not a url" } });
  const resolved = await resolveModel(
    input,
    deps({ workspace: workspaceRow(false, broken) }),
  );
  assert.equal(resolved.ok, false);
  assert.match(!resolved.ok ? resolved.problem : "", /save it again/);
});

/* -------------------------------------------------------------------------- */
/* Saving                                                                     */
/* -------------------------------------------------------------------------- */

const ip = (baseUrl: string, apiKey?: string): ModelConfigInput => ({
  settings: { provider: "openai-compatible", baseUrl, model: "m", api: "responses" },
  ...(apiKey === undefined ? {} : { credentials: apiKey === "" ? null : { apiKey } }),
});
// An address literal is checked without DNS, which keeps these offline.
const PUBLIC = "https://93.184.216.34/v1";

test("a save seals a new key, keeps the stored one, or clears it", async () => {
  const d = deps({});
  const fresh = await prepareWrite(ip(PUBLIC, "sk-new-key-0123456789"), null, d);
  assert.ok(Buffer.isBuffer(fresh.credentials));
  assert.ok(!fresh.credentials.toString("utf8").includes("sk-new-key"));
  assert.deepEqual(openCredentials(fresh.credentials), {
    state: "ok",
    credentials: { apiKey: "sk-new-key-0123456789" },
  });
  assert.deepEqual(fresh.settings, { baseUrl: PUBLIC, model: "m", api: "responses" });

  const current = stored({
    settings: { baseUrl: `${PUBLIC}/`, model: "m", api: "chat" },
  });
  assert.equal((await prepareWrite(ip(PUBLIC), current, d)).credentials, "keep");
  assert.equal((await prepareWrite(ip(PUBLIC, ""), current, d)).credentials, null);
});

test("a stored key cannot be pointed at a different host without entering it again", async () => {
  const current = stored({ settings: { baseUrl: PUBLIC, model: "m", api: "chat" } });
  await assert.rejects(
    prepareWrite(ip("https://93.184.216.35/v1"), current, deps({})),
    /different host than the stored key was entered for, so enter the API key again/,
  );
  // With the key entered again, it is a new key for the new host.
  const moved = await prepareWrite(
    ip("https://93.184.216.35/v1", "sk-x"),
    current,
    deps({}),
  );
  assert.ok(Buffer.isBuffer(moved.credentials));
});

/** Every kind whose endpoint a person types (#331, #592). */
const TYPED_ENDPOINT_KINDS = PROVIDER_KIND_NAMES.filter(
  (name) => providerKind(name)?.userSetsEndpoint,
);

test("a save refuses a base URL the guard refuses, for every kind with a typed endpoint", async () => {
  assert.deepEqual(TYPED_ENDPOINT_KINDS.sort(), [
    "anthropic-compatible",
    "openai-compatible",
  ]);
  for (const provider of TYPED_ENDPOINT_KINDS) {
    const typed = (baseUrl: string) =>
      ({ settings: { provider, baseUrl, model: "m" } }) as ModelConfigInput;
    await assert.rejects(
      prepareWrite(typed("https://169.254.169.254/latest"), null, deps({})),
      /not a public address/,
      provider,
    );
    await assert.rejects(
      prepareWrite(typed("http://93.184.216.34/v1"), null, deps({})),
      /https/,
      provider,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* The key never leaves                                                       */
/* -------------------------------------------------------------------------- */

const KEY = "ollama-has-no-shape-but-this-is-a-key";

test("a view of a configuration carries the key's state and last four characters, never the key", async () => {
  const row = stored({ credentials: sealCredentials({ apiKey: KEY }) });
  const view = configView(row);
  assert.deepEqual(view?.key, { state: "set", hint: "-key" });
  assert.ok(!JSON.stringify(view).includes(KEY));

  const ws = await workspaceModelView("w", deps({ workspace: workspaceRow(true, row) }));
  assert.ok(!JSON.stringify(ws).includes(KEY));
  assert.ok(!JSON.stringify(ws).includes("apiKey"));
  assert.equal(ws.allowPersonalKeys, true);

  assert.deepEqual(
    configView(stored({ credentials: sealCredentials({ apiKey: "short" }) }))?.key,
    {
      state: "set",
      hint: null,
    },
  );
  assert.equal(keyHint("0123456789abcde"), null);
  assert.equal(keyHint("0123456789abcdef"), "cdef");
});

test("an opened key is scrubbed from log lines, audit rows and the generation log", () => {
  const sealed = sealCredentials({ apiKey: KEY });
  openCredentials(sealed);
  assert.equal(
    redactString(`provider said: bad key ${KEY}!`),
    "provider said: bad key [redacted]!",
  );

  const row = generationRow({
    workspaceId: "w",
    createdBy: "alice",
    mode: "dashboard",
    sourceId: "s",
    prompt: `use key ${KEY} please`,
    catalog: null,
    spec: null,
    model: "m",
    modelConfig: "workspace",
    error: new Error(`401 for ${KEY}`),
  });
  assert.ok(!JSON.stringify(row).includes(KEY));
  assert.equal(row.modelConfig, "workspace");

  const audit = auditRow({
    actor: alice,
    action: "workspace.model.test",
    workspaceId: "w",
    detail: { message: `refused ${KEY}` },
  });
  assert.ok(!JSON.stringify(audit).includes(KEY));
});

test("a key too short to match safely is not registered, so ordinary words survive", () => {
  rememberSecret("ollama");
  assert.equal(redactString("ollama runs locally"), "ollama runs locally");
});

/* -------------------------------------------------------------------------- */
/* The settings form                                                          */
/* -------------------------------------------------------------------------- */

test("the form keeps a stored key when the key field is blank, and clears it on request", () => {
  const base = {
    provider: "openai-compatible",
    settings: {
      baseUrl: " https://openrouter.ai/api/v1 ",
      model: " openai/gpt-4o-mini ",
      api: "responses",
    },
    credentials: { apiKey: "" },
    clearCredentials: false,
  };
  const keep = inputFromDraft(base);
  assert.ok(keep.ok);
  assert.deepEqual(keep.ok && keep.input, {
    settings: {
      provider: "openai-compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openai/gpt-4o-mini",
      api: "responses",
    },
  });
  const replace = inputFromDraft({ ...base, credentials: { apiKey: " sk-1 " } });
  assert.deepEqual(replace.ok && replace.input.credentials, { apiKey: "sk-1" });
  const clear = inputFromDraft({
    ...base,
    credentials: { apiKey: "ignored" },
    clearCredentials: true,
  });
  assert.equal(clear.ok && clear.input.credentials, null);

  const bad = inputFromDraft({
    ...base,
    settings: { ...base.settings, baseUrl: "openrouter" },
  });
  assert.equal(bad.ok, false);
  assert.match(!bad.ok ? bad.message : "", /^Base URL/);
  const noModel = inputFromDraft({ ...base, settings: { ...base.settings, model: " " } });
  assert.match(!noModel.ok ? noModel.message : "", /^Model/);
});

test("the key's state is described without the key", () => {
  assert.equal(describeKey({ state: "none" }), "No key stored.");
  assert.equal(
    describeKey({ state: "set", hint: "abcd" }),
    "A key ending in abcd is stored.",
  );
  assert.match(describeKey({ state: "unreadable" }), /SESSION_SECRET changed/);
});

/* -------------------------------------------------------------------------- */
/* Provider kinds (#438)                                                      */
/* -------------------------------------------------------------------------- */

const PAIR = {
  accessKeyId: "AKIAPAIRTEST00000000",
  secretAccessKey: "bedrock-secret-access-key-0123456789",
};

test("a bare key sealed before #438 opens as { apiKey }, and a lone key is still sealed bare", () => {
  const legacy = sealSecret("sk-legacy-key-0123456789", "holotable model-api-key v1");
  assert.deepEqual(openCredentials(legacy), {
    state: "ok",
    credentials: { apiKey: "sk-legacy-key-0123456789" },
  });
  // What #331 code would read during a rolling update: the key itself.
  const fresh = sealCredentials({ apiKey: "sk-fresh-key-0123456789" });
  assert.equal(
    openSecret(fresh as Buffer, "holotable model-api-key v1"),
    "sk-fresh-key-0123456789",
  );
  assert.equal(sealCredentials({}), null);
  assert.equal(sealCredentials({ apiKey: "" }), null);
});

test("a Bedrock key pair round-trips sealed, and never reaches a log line, an audit row or a view", async () => {
  const sealed = sealCredentials(PAIR);
  assert.ok(sealed && !sealed.toString("utf8").includes(PAIR.secretAccessKey));
  assert.deepEqual(openCredentials(sealed), { state: "ok", credentials: PAIR });

  assert.equal(
    redactString(`denied ${PAIR.secretAccessKey} for ${PAIR.accessKeyId}`),
    "denied [redacted] for [redacted]",
  );
  const audit = auditRow({
    actor: alice,
    action: "workspace.model.test",
    workspaceId: "w",
    detail: { message: `refused ${PAIR.secretAccessKey}` },
  });
  assert.ok(!JSON.stringify(audit).includes(PAIR.secretAccessKey));

  const row = stored({
    provider: "bedrock",
    settings: { region: "us-east-1", model: "anthropic.claude" },
    credentials: sealed,
  });
  const view = configView(row);
  assert.deepEqual(view?.key, { state: "set", hint: "0000" });
  assert.ok(!JSON.stringify(view).includes(PAIR.secretAccessKey));
  const ws = await workspaceModelView("w", deps({ workspace: workspaceRow(false, row) }));
  assert.ok(!JSON.stringify(ws).includes(PAIR.secretAccessKey));
});

const fixed = (
  provider: string,
  settings: Record<string, unknown>,
  credentials?: Record<string, string> | null,
): ModelConfigInput =>
  ({
    settings: { provider, ...settings },
    ...(credentials === undefined ? {} : { credentials }),
  }) as ModelConfigInput;

test("a fixed vendor needs its key, and keeps it only while requests go to the same host", async () => {
  const d = deps({});
  await assert.rejects(
    prepareWrite(fixed("anthropic", { model: "claude" }), null, d),
    /API key/,
  );
  await assert.rejects(
    prepareWrite(fixed("anthropic", { model: "claude" }, null), null, d),
    /API key/,
  );
  const saved = await prepareWrite(
    fixed("anthropic", { model: "claude" }, { apiKey: "sk-ant-0123456789abcdef" }),
    null,
    d,
  );
  assert.deepEqual(saved.settings, { model: "claude" });
  assert.equal(saved.provider, "anthropic");

  const current = stored({
    provider: "anthropic",
    settings: { model: "claude" },
    credentials: saved.credentials as Buffer,
  });
  // Another model at the same vendor keeps the key.
  assert.equal(
    (await prepareWrite(fixed("anthropic", { model: "claude-2" }), current, d))
      .credentials,
    "keep",
  );
  // Another vendor does not.
  await assert.rejects(
    prepareWrite(fixed("openai", { model: "gpt" }), current, d),
    /different host/,
  );

  const azure = stored({
    provider: "azure",
    settings: { resourceName: "one", model: "dep", api: "chat" },
  });
  await assert.rejects(
    prepareWrite(
      fixed("azure", { resourceName: "two", model: "dep", api: "chat" }),
      azure,
      d,
    ),
    /different host/,
  );
  assert.equal(
    (
      await prepareWrite(
        fixed("azure", { resourceName: "one", model: "dep2", api: "chat" }),
        azure,
        d,
      )
    ).credentials,
    "keep",
  );

  // A key pair is entered whole.
  await assert.rejects(
    prepareWrite(
      fixed("bedrock", { region: "us-east-1", model: "m" }, { accessKeyId: "AKIA" }),
      null,
      d,
    ),
    /Secret access key/,
  );
});

test("the stub kind is refused on a production server unless it is the end-to-end suite's", async () => {
  const stub = fixed("stub", {});
  await assert.rejects(
    prepareWrite(stub, null, deps({}, { env: { NODE_ENV: "production" } })),
    /not available on a production server/,
  );
  const allowed = await prepareWrite(
    stub,
    null,
    deps({}, { env: { NODE_ENV: "production", AI_STUB_IN_PRODUCTION: "true" } }),
  );
  assert.equal(allowed.provider, "stub");
  assert.equal((await prepareWrite(stub, null, deps({}))).provider, "stub");
});

test("a stored model of every kind resolves; one missing its credentials is reported", async () => {
  const kinds: Array<[string, Record<string, unknown>, Record<string, string>]> = [
    ["openai", { model: "gpt" }, { apiKey: "k" }],
    ["anthropic", { model: "claude" }, { apiKey: "k" }],
    ["google", { model: "gemini" }, { apiKey: "k" }],
    ["gateway", { model: "a/b" }, { apiKey: "k" }],
    ["azure", { resourceName: "r", model: "d" }, { apiKey: "k" }],
    ["bedrock", { region: "us-east-1", model: "m" }, PAIR],
    ["mistral", { model: "m" }, { apiKey: "k" }],
    ["xai", { model: "grok" }, { apiKey: "k" }],
    ["stub", {}, {}],
  ];
  for (const [provider, settings, credentials] of kinds) {
    const row = stored({ provider, settings, credentials: sealCredentials(credentials) });
    const resolved = await resolveModel(
      input,
      deps({ workspace: workspaceRow(false, row) }),
    );
    assert.equal(resolved.ok, true, provider);
  }
  const keyless = stored({
    provider: "anthropic",
    settings: { model: "c" },
    credentials: null,
  });
  const missing = await resolveModel(
    input,
    deps({ workspace: workspaceRow(false, keyless) }),
  );
  assert.equal(missing.ok, false);
  assert.match(!missing.ok ? missing.problem : "", /no usable credentials/);
});
