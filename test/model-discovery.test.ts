import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseBaseUrlAllowlist } from "@/lib/ai/base-url";
import { modelsToDiscover, workspaceOwner } from "@/lib/ai/model-admin";
import { ModelSettings } from "@/lib/ai/model-config";
import { type ModelResolutionDeps, sealCredentials } from "@/lib/ai/model-resolution";
import type { Credentials } from "@/lib/ai/providers/registry";
import { MAX_MODEL_LIST_BYTES } from "@/lib/ai/providers/server/list";
import { serverProviderKind } from "@/lib/ai/providers/server/registry";
import { forgetServerModelFiles, serverModelByName } from "@/lib/ai/server-model-list";
import { HttpError } from "@/lib/auth/authorize";
import { memoryModelStore, storedModel } from "./support/models";

/**
 * Model discovery (#443): each kind that can list its models does so
 * through the fetch it is given, sends its own credentials, reduces the
 * reply to ids and names, and refuses a reply over the byte cap.
 */

const KEY = "sk-discovery-0123456789";

type Seen = { url: URL; headers: Headers };

function vendor(body: unknown, status = 200) {
  const seen: Seen[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    seen.push({ url, headers: new Headers(init?.headers) });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, seen };
}

const CASES: Array<{
  name: string;
  settings: Record<string, unknown>;
  reply: unknown;
  origin: string;
  path: RegExp;
  keyHeader: [string, string];
  expected: Array<{ id: string; name?: string }>;
}> = [
  {
    name: "openai",
    settings: { provider: "openai", model: "x" },
    reply: { data: [{ id: "gpt-5" }, { id: "gpt-4o" }, { id: "gpt-5" }] },
    origin: "https://api.openai.com",
    path: /^\/v1\/models$/,
    keyHeader: ["authorization", `Bearer ${KEY}`],
    expected: [{ id: "gpt-4o" }, { id: "gpt-5" }],
  },
  {
    name: "openai-compatible",
    settings: {
      provider: "openai-compatible",
      baseUrl: "https://llm.example.com/api/v1",
      model: "x",
    },
    reply: { data: [{ id: "meta/llama-3", name: "Llama 3" }] },
    origin: "https://llm.example.com",
    path: /^\/api\/v1\/models$/,
    keyHeader: ["authorization", `Bearer ${KEY}`],
    expected: [{ id: "meta/llama-3", name: "Llama 3" }],
  },
  {
    name: "anthropic",
    settings: { provider: "anthropic", model: "x" },
    reply: { data: [{ id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" }] },
    origin: "https://api.anthropic.com",
    path: /^\/v1\/models$/,
    keyHeader: ["x-api-key", KEY],
    expected: [{ id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" }],
  },
  {
    name: "google",
    settings: { provider: "google", model: "x" },
    reply: {
      models: [
        {
          name: "models/gemini-2.5-pro",
          displayName: "Gemini 2.5 Pro",
          supportedGenerationMethods: ["generateContent"],
        },
        { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
      ],
    },
    origin: "https://generativelanguage.googleapis.com",
    path: /^\/v1beta\/models$/,
    keyHeader: ["x-goog-api-key", KEY],
    expected: [{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }],
  },
  {
    name: "mistral",
    settings: { provider: "mistral", model: "x" },
    reply: { data: [{ id: "mistral-large-latest" }] },
    origin: "https://api.mistral.ai",
    path: /^\/v1\/models$/,
    keyHeader: ["authorization", `Bearer ${KEY}`],
    expected: [{ id: "mistral-large-latest" }],
  },
  {
    name: "xai",
    settings: { provider: "xai", model: "x" },
    reply: { data: [{ id: "grok-4" }] },
    origin: "https://api.x.ai",
    path: /^\/v1\/models$/,
    keyHeader: ["authorization", `Bearer ${KEY}`],
    expected: [{ id: "grok-4" }],
  },
];

for (const c of CASES) {
  test(`a ${c.name} model list is read from its own endpoint with its own key`, async () => {
    const settings = ModelSettings.parse(c.settings);
    const { fetch, seen } = vendor(c.reply);
    const kind = serverProviderKind(settings);
    assert.ok(kind.listModels, `${c.name} lists its models`);
    const models = await kind.listModels(settings, { apiKey: KEY } as Credentials, fetch);
    assert.deepEqual(models, c.expected);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url.origin, c.origin);
    assert.match(seen[0].url.pathname, c.path);
    assert.equal(seen[0].headers.get(c.keyHeader[0]), c.keyHeader[1]);
  });

  test(`a ${c.name} model list over the byte cap is refused`, async () => {
    const settings = ModelSettings.parse(c.settings);
    const huge = `{"data":[${'{"id":"x"},'.repeat(MAX_MODEL_LIST_BYTES / 10)}{"id":"y"}]}`;
    const { fetch } = vendor(huge);
    await assert.rejects(
      serverProviderKind(settings).listModels?.(settings, { apiKey: KEY }, fetch) ??
        Promise.reject(new Error("no listModels")),
      /larger than 4 MiB; type the model id/,
    );
  });
}

test("the gateway lists through its SDK, under the same cap", async () => {
  const settings = ModelSettings.parse({ provider: "gateway", model: "x" });
  const spec = (modelId: string) => ({
    specificationVersion: "v4",
    provider: "x",
    modelId,
  });
  const { fetch, seen } = vendor({
    models: [
      {
        id: "anthropic/claude-sonnet-5-5",
        name: "Claude Sonnet 5.5",
        specification: spec("claude-sonnet-5-5"),
        modelType: "language",
      },
      {
        id: "openai/text-embedding-3",
        name: "Embedding",
        specification: spec("text-embedding-3"),
        modelType: "embedding",
      },
    ],
  });
  const models = await serverProviderKind(settings).listModels?.(
    settings,
    { apiKey: KEY },
    fetch,
  );
  assert.deepEqual(models, [
    { id: "anthropic/claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  ]);
  assert.equal(seen[0].url.origin, "https://ai-gateway.vercel.sh");
});

test("Azure and Bedrock models are typed by hand; the stub lists a fixed one", async () => {
  for (const settings of [
    { provider: "azure", resourceName: "r", model: "d" },
    { provider: "bedrock", region: "us-east-1", model: "m" },
  ]) {
    assert.equal(serverProviderKind(ModelSettings.parse(settings)).listModels, undefined);
  }
  const stub = ModelSettings.parse({ provider: "stub" });
  assert.deepEqual(await serverProviderKind(stub).listModels?.(stub, {}, fetch), [
    { id: "stub", name: "Recorded answers" },
  ]);
});

test("a refusal is a sentence with the status, never the vendor's body", async () => {
  const settings = ModelSettings.parse({ provider: "openai", model: "x" });
  const { fetch } = vendor({ error: { message: `bad key ${KEY}` } }, 401);
  await assert.rejects(
    serverProviderKind(settings).listModels?.(settings, { apiKey: KEY }, fetch) ??
      Promise.reject(new Error("no listModels")),
    (err: Error) =>
      err.message === "The provider refused the credentials (401)." &&
      !err.message.includes(KEY),
  );
});

/* --- The discovery service ------------------------------------------------- */

function deps(models = [] as ReturnType<typeof storedModel>[]): ModelResolutionDeps {
  return {
    store: memoryModelStore({ models }),
    demo: false,
    env: {},
    allowlist: parseBaseUrlAllowlist(""),
  };
}

test("a kind that cannot list is told to type the id", async () => {
  await assert.rejects(
    modelsToDiscover(
      workspaceOwner("w"),
      {
        settings: { provider: "azure", resourceName: "r", model: "d", api: "responses" },
        credentials: { apiKey: KEY },
      },
      null,
      deps(),
    ),
    (err: unknown) =>
      err instanceof HttpError &&
      err.status === 400 &&
      /type the model id/.test(err.message),
  );
});

test("discovery uses a saved model's credentials when the form leaves them out", async () => {
  const saved = storedModel({
    provider: "stub",
    settings: { model: "stub" },
    credentials: null,
  });
  const result = await modelsToDiscover(
    workspaceOwner("w"),
    { settings: { provider: "stub", model: "*" } },
    saved.id,
    deps([saved]),
  );
  assert.deepEqual(result, {
    ok: true,
    models: [{ id: "stub", name: "Recorded answers" }],
  });
  // Another workspace cannot borrow them.
  await assert.rejects(
    modelsToDiscover(
      workspaceOwner("x"),
      { settings: { provider: "stub", model: "*" } },
      saved.id,
      deps([saved]),
    ),
    (err: unknown) => err instanceof HttpError && err.status === 404,
  );
  // A key pointed at another host must be entered again, as for a save.
  const anthropic = storedModel({
    provider: "anthropic",
    settings: { model: "claude" },
    credentials: sealCredentials({ apiKey: KEY }),
  });
  await assert.rejects(
    modelsToDiscover(
      workspaceOwner("w"),
      { settings: { provider: "openai", model: "*" } },
      anthropic.id,
      deps([anthropic]),
    ),
    /different host/,
  );
});

test("the discover route takes the test routes' roles and records its own event", () => {
  const text = readFileSync(
    new URL("../src/app/api/models/discover/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(text, /assertManages\(identity, workspaceId\)/);
  assert.match(text, /personalOwner\(identity\)/);
  assert.match(text, /allowPersonalKeys/);
  assert.match(text, /enforceLlmLimits\(/);
});

/* --- eval --model ----------------------------------------------------------- */

test("a server model is found by name, and an unknown name lists the names on offer", () => {
  forgetServerModelFiles();
  const env = {
    AI_PROVIDER: "stub",
    AI_MODELS_FILE: new URL("../e2e/models.json", import.meta.url).pathname,
  };
  const found = serverModelByName("stub-b", env);
  assert.equal(found.ok && found.model.id, "env:stub-b");
  const fallback = serverModelByName(undefined, env);
  assert.equal(fallback.ok && fallback.model.id, "env:default");
  assert.deepEqual(serverModelByName("gpt", env), {
    ok: false,
    message: 'No server model is named "gpt". On offer: default, stub-a, stub-b.',
  });
});
