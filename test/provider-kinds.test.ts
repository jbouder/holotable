import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, relative } from "node:path";
import { generateText } from "ai";
import { parseBaseUrlAllowlist } from "@/lib/ai/base-url";
import { BaseUrlRefusedError, pinnedFetch } from "@/lib/ai/guarded-fetch";
import { ModelSettings } from "@/lib/ai/model-config";
import {
  type Credentials,
  endpointOf,
  PROVIDER_KIND_NAMES,
  PROVIDER_KINDS,
  parseCredentials,
  providerKind,
  selectableKinds,
} from "@/lib/ai/providers/registry";
import { buildModel, SERVER_PROVIDER_KINDS } from "@/lib/ai/providers/server/registry";

/**
 * The provider kind registry (#438): what a model may be configured
 * against is declared once per kind, and nothing outside
 * `src/lib/ai/providers/` decides by comparing a provider or reaches a
 * vendor SDK directly. These tests hold the code to that, and check that
 * each kind's model goes where its kind says, with its own credentials and
 * never the server's.
 */

const ROOT = new URL("..", import.meta.url).pathname;
const NO_ALLOWLIST = parseBaseUrlAllowlist("");

function files(dir: string): string[] {
  const found: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const path = join(d, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(entry)) found.push(path);
    }
  };
  walk(join(ROOT, dir));
  return found;
}

const APP_FILES = [...files("src"), ...files("scripts")].map((path) => ({
  path: relative(ROOT, path),
  text: readFileSync(path, "utf8"),
}));

/** A decision made by comparing a configured model's provider, rather than asking its kind. */
const PROVIDER_COMPARISONS: RegExp[] = [
  /\.provider\s*[!=]==\s*["'`]/,
  /["'`]\s*[!=]==\s*[\w.?]*\.provider\b/,
  /case\s+["'](?:openai-compatible|openai|anthropic-compatible|anthropic|google|gateway|azure|bedrock|mistral|xai)["']/,
  /switch\s*\(\s*[\w.?]*\.provider\s*\)/,
];

test("no code outside src/lib/ai/providers/ switches on a model's provider", () => {
  const offenders = APP_FILES.filter(
    ({ path }) => !path.startsWith("src/lib/ai/providers/"),
  ).flatMap(({ path, text }) =>
    text
      .split("\n")
      .map((line, i) => ({ line, at: `${path}:${i + 1}` }))
      .filter(({ line }) => PROVIDER_COMPARISONS.some((re) => re.test(line)))
      .map(({ at, line }) => `${at}: ${line.trim()}`),
  );
  assert.deepEqual(offenders, [], "ask providerKind() or kindOf() instead");
});

test("vendor SDKs are imported only by the kinds' server halves", () => {
  // `@ai-sdk/react` is the browser's hooks, not a vendor; the stub builds a
  // model by hand and imports only types from `ai`.
  const offenders = APP_FILES.filter(
    ({ path, text }) =>
      !path.startsWith("src/lib/ai/providers/server/") &&
      /from\s+["']@ai-sdk\/(?!react["'])/.test(text),
  ).map(({ path }) => path);
  assert.deepEqual(offenders, []);
});

test("every kind has a server half of the same name, and nothing else does", () => {
  assert.deepEqual(
    Object.keys(SERVER_PROVIDER_KINDS).sort(),
    [...PROVIDER_KIND_NAMES].sort(),
  );
  for (const name of PROVIDER_KIND_NAMES) {
    assert.equal(PROVIDER_KINDS[name].kind, name);
    assert.equal(SERVER_PROVIDER_KINDS[name].kind, name);
  }
  assert.equal(providerKind("toString"), null);
  assert.equal(providerKind("nope"), null);
});

test("each kind's settings reject unknown keys and require a model", () => {
  for (const name of PROVIDER_KIND_NAMES) {
    const kind = providerKind(name);
    assert.ok(kind);
    const extra = kind.settings.safeParse({ ...validSettings(name), surprise: 1 });
    assert.equal(extra.success, false, `${name} accepted an unknown key`);
    // The stub has nothing to name, so its model defaults.
    if (kind.developmentOnly) continue;
    const { model: _, ...withoutModel } = validSettings(name);
    assert.equal(
      kind.settings.safeParse(withoutModel).success,
      false,
      `${name} accepted no model`,
    );
  }
});

test("a configuration stored by #331 parses unchanged", () => {
  const stored = {
    provider: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o-mini",
    api: "chat",
  };
  assert.deepEqual(ModelSettings.parse(stored), stored);
  // A row written before `api` existed takes the old default.
  const { api: _, ...older } = stored;
  assert.deepEqual(ModelSettings.parse(older), { ...older, api: "responses" });
});

test("the stub is offered only where it may be saved", () => {
  assert.ok(selectableKinds(false).some((k) => k.kind === "stub"));
  assert.ok(!selectableKinds(true).some((k) => k.kind === "stub"));
  assert.equal(selectableKinds(true).length, PROVIDER_KIND_NAMES.length - 1);
});

test("credentials are held to their kind's shape, naming the field and never the value", () => {
  const anthropic = providerKind("anthropic");
  const bedrock = providerKind("bedrock");
  const compatible = providerKind("openai-compatible");
  assert.ok(anthropic && bedrock && compatible);
  assert.deepEqual(parseCredentials(anthropic, {}), {
    ok: false,
    message: "API key: Invalid input: expected string, received undefined",
  });
  const half = parseCredentials(bedrock, { accessKeyId: "AKIAEXAMPLE" });
  assert.equal(half.ok, false);
  assert.match(!half.ok ? half.message : "", /^Secret access key/);
  assert.ok(!(!half.ok && half.message.includes("AKIAEXAMPLE")));
  const extra = parseCredentials(anthropic, { apiKey: "k", password: "p" });
  assert.match(!extra.ok ? extra.message : "", /takes no password/);
  // A keyless endpoint: an empty key is no key.
  assert.deepEqual(parseCredentials(compatible, { apiKey: "" }), {
    ok: true,
    credentials: {},
  });
});

/* -------------------------------------------------------------------------- */
/* Each kind's model                                                          */
/* -------------------------------------------------------------------------- */

const SECRET = "sk-kind-secret-0123456789";

function validSettings(name: string): Record<string, unknown> {
  const base = { provider: name, model: "some-model" };
  switch (name) {
    case "openai-compatible":
      return { ...base, baseUrl: "https://llm.example.com/v1", api: "chat" };
    case "anthropic-compatible":
      return { ...base, baseUrl: "https://llm.example.com/zen/v1" };
    case "azure":
      return { ...base, resourceName: "my-resource", api: "chat" };
    case "bedrock":
      return { ...base, region: "eu-central-1" };
    default:
      return base;
  }
}

function validCredentials(name: string): Credentials {
  if (name === "bedrock") {
    return { accessKeyId: "AKIAKINDTEST000000", secretAccessKey: SECRET };
  }
  if (name === "stub") return {};
  return { apiKey: SECRET };
}

/** What the server's own environment holds, which a stored model must never use. */
const SERVER_ENV: Record<string, string> = {
  OPENAI_API_KEY: "server-openai-key",
  OPENAI_BASE_URL: "https://server-proxy.example.net/v1",
  ANTHROPIC_API_KEY: "server-anthropic-key",
  ANTHROPIC_BASE_URL: "https://server-proxy.example.net",
  GOOGLE_GENERATIVE_AI_API_KEY: "server-google-key",
  AI_GATEWAY_API_KEY: "server-gateway-key",
  AZURE_API_KEY: "server-azure-key",
  AZURE_RESOURCE_NAME: "server-resource",
  AWS_BEARER_TOKEN_BEDROCK: "server-bedrock-token",
  AWS_ACCESS_KEY_ID: "AKIASERVER00000000",
  AWS_SECRET_ACCESS_KEY: "server-aws-secret",
  AWS_SESSION_TOKEN: "server-aws-session",
  AWS_ENDPOINT_URL: "https://server-proxy.example.net",
  MISTRAL_API_KEY: "server-mistral-key",
  XAI_API_KEY: "server-xai-key",
};

async function withServerEnv<T>(run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(
    Object.keys(SERVER_ENV).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, SERVER_ENV);
  try {
    return await run();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** The one request a model makes, captured and refused. */
async function firstRequest(name: string) {
  const settings = ModelSettings.parse(validSettings(name));
  let seen: { url: URL; headers: Headers; body: string } | undefined;
  const capture: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    seen = { url, headers: new Headers(init?.headers), body: String(init?.body ?? "") };
    return new Response(JSON.stringify({ error: { message: "stop here" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  };
  const model = buildModel(settings, validCredentials(name), NO_ALLOWLIST, capture);
  await withServerEnv(() =>
    generateText({ model, prompt: "x", maxRetries: 0 }).catch(() => undefined),
  );
  return { settings, seen };
}

for (const name of PROVIDER_KIND_NAMES) {
  if (name === "stub") continue;
  test(`a ${name} model calls its own endpoint with its own credentials`, async () => {
    const { settings, seen } = await firstRequest(name);
    assert.ok(seen, "no request was made");
    const endpoint = endpointOf(settings);
    assert.ok(endpoint);
    assert.equal(seen.url.origin, new URL(endpoint).origin);

    const sent = `${seen.url.href}\n${[...seen.headers].map(([k, v]) => `${k}: ${v}`).join("\n")}`;
    if (name === "bedrock") {
      // Signed with the stored pair (SigV4), never the server's bearer token or keys.
      assert.match(
        seen.headers.get("authorization") ?? "",
        /^AWS4-HMAC-SHA256 Credential=AKIAKINDTEST000000\//,
      );
      assert.ok(!seen.headers.has("x-amz-security-token"));
    } else {
      assert.ok(sent.includes(SECRET), `${name} did not send its key`);
    }
    for (const value of Object.values(SERVER_ENV)) {
      assert.ok(!sent.includes(value), `${name} sent the server's ${value}`);
    }
  });
}

test("the stub model makes no request", async () => {
  const model = buildModel(ModelSettings.parse({ provider: "stub" }), {}, NO_ALLOWLIST);
  assert.equal(model.provider, "holotable-stub");
});

test("each fixed kind's endpoint is its vendor's, derived only from a resource or region", () => {
  const origin = (s: Record<string, unknown>) => endpointOf(ModelSettings.parse(s));
  assert.equal(origin(validSettings("openai")), "https://api.openai.com");
  assert.equal(origin(validSettings("anthropic")), "https://api.anthropic.com");
  assert.equal(origin(validSettings("azure")), "https://my-resource.openai.azure.com");
  assert.equal(
    origin(validSettings("bedrock")),
    "https://bedrock-runtime.eu-central-1.amazonaws.com",
  );
  assert.equal(
    origin({ ...validSettings("bedrock"), region: "cn-north-1" }),
    "https://bedrock-runtime.cn-north-1.amazonaws.com.cn",
  );
  // A resource or region cannot smuggle a host in.
  for (const resourceName of ["evil.com/x", "a.b", "-x", "x".repeat(70)]) {
    assert.equal(
      ModelSettings.safeParse({ ...validSettings("azure"), resourceName }).success,
      false,
      resourceName,
    );
  }
  for (const region of ["us-east-1.evil.com", "us-east-1/", "local"]) {
    assert.equal(
      ModelSettings.safeParse({ ...validSettings("bedrock"), region }).success,
      false,
      region,
    );
  }
});

test("a fixed kind's fetch reaches its own origin only and follows no redirect", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "http://169.254.169.254/" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const fetch = pinnedFetch(origin);
    assert.deepEqual(await (await fetch(`${origin}/v1/models`)).json(), {
      path: "/v1/models",
    });
    await assert.rejects(fetch(`${origin}/redirect`), BaseUrlRefusedError);
    await assert.rejects(
      fetch("https://server-proxy.example.net/v1"),
      /not the provider's/,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
