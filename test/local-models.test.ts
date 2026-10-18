import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type BaseUrlAllowlist,
  baseUrlShapeProblem,
  parseBaseUrlAllowlist,
} from "@/lib/ai/base-url";
import {
  detectedModelId,
  detectionAllowlist,
  endpointLabel,
  forgetLocalScan,
  type ScanDeps,
  scanLocalModels,
} from "@/lib/ai/local-models";
import { ModelId } from "@/lib/ai/model-config";
import type { ModelResolutionDeps } from "@/lib/ai/model-resolution";
import { requireModel, usableModels } from "@/lib/ai/models";
import { MAX_MODEL_LIST_BYTES } from "@/lib/ai/providers/server/list";
import { serverModelList, serverModelProblem } from "@/lib/ai/server-model-list";
import { parseGroups } from "@/lib/auth/claims";
import { createLogger, setLogger } from "@/lib/log";
import { memoryModelStore } from "./support/models";

/**
 * A model on the person's own machine (#607): detection probes only the
 * operator's endpoints, only while it is on, through a fetch that gives up on
 * a dead, slow, malformed or oversized endpoint; what it finds is named so it
 * cannot collide with a declared model, and becomes the default only when it
 * is the one answer.
 */

const OLLAMA = "http://localhost:11434/v1";
const LM_STUDIO = "http://localhost:1234/v1";
const REPLY_SECRET = "reply-body-must-never-be-logged";

type Behavior =
  | { models: string[] }
  | { status: number }
  | { text: string }
  | { bytes: number }
  | "dead"
  | "hang";

/** A stub of each endpoint, by base URL; nothing reaches the network. */
function machine(behaviors: Record<string, Behavior>) {
  const asked: string[] = [];
  const allowlists: BaseUrlAllowlist[] = [];
  const fetchFor: NonNullable<ScanDeps["fetchFor"]> = (baseUrl, allowlist) => {
    allowlists.push(allowlist);
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      asked.push(url);
      const behavior = behaviors[baseUrl] ?? "dead";
      if (behavior === "dead") throw new TypeError("fetch failed");
      if (behavior === "hang") {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        });
      }
      if ("status" in behavior)
        return new Response(REPLY_SECRET, { status: behavior.status });
      if ("text" in behavior) return new Response(behavior.text, { status: 200 });
      if ("bytes" in behavior)
        return new Response("x".repeat(behavior.bytes), { status: 200 });
      return Response.json({
        object: "list",
        data: behavior.models.map((id) => ({ id, object: "model" })),
      });
    }) as typeof fetch;
  };
  return { fetchFor, asked, allowlists };
}

function capturedLog() {
  const lines: Array<Record<string, unknown>> = [];
  const restore = setLogger(
    createLogger({
      level: "info",
      format: "json",
      sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    }),
  );
  return { lines, restore };
}

const owner = parseGroups("owner", ["/workspaces/local/source-admin"]);

function deps(env: Record<string, string>): ModelResolutionDeps {
  return {
    store: memoryModelStore(),
    demo: false,
    env,
    allowlist: parseBaseUrlAllowlist(env.AI_BASE_URL_ALLOWLIST),
  };
}

test("detection is off outside local mode unless asked for, and then probes nothing", async () => {
  forgetLocalScan();
  for (const env of [
    {},
    { AUTH_MODE: "oidc" },
    { AUTH_MODE: "demo" },
    { AUTH_MODE: "local", LOCAL_MODEL_DETECT: "off" },
    { AUTH_MODE: "local", LOCAL_MODEL_DETECT: "typo" },
  ]) {
    const stub = machine({ [OLLAMA]: { models: ["llama3.2"] } });
    const scan = await scanLocalModels({ env, fetchFor: stub.fetchFor });
    assert.equal(scan, null, JSON.stringify(env));
    assert.deepEqual(stub.asked, [], JSON.stringify(env));
    assert.equal(detectionAllowlist(env), null);
    assert.deepEqual(
      serverModelList(env).filter((m) => m.detected),
      [],
    );
  }
  const on = machine({ [OLLAMA]: { models: ["llama3.2"] } });
  const scan = await scanLocalModels({
    env: { LOCAL_MODEL_DETECT: "on", LOCAL_MODEL_ENDPOINTS: OLLAMA },
    fetchFor: on.fetchFor,
  });
  assert.ok(scan);
  assert.deepEqual(on.asked, [`${OLLAMA}/models`]);
});

test("the default endpoints are Ollama's and LM Studio's, inside a container and out", async () => {
  forgetLocalScan();
  const stub = machine({});
  const scan = await scanLocalModels({
    env: { AUTH_MODE: "local" },
    fetchFor: stub.fetchFor,
  });
  assert.deepEqual(
    scan?.endpoints.map((e) => e.baseUrl),
    [
      "http://host.docker.internal:11434/v1",
      OLLAMA,
      "http://host.docker.internal:1234/v1",
      LM_STUDIO,
    ],
  );
  assert.deepEqual(
    scan?.endpoints.map((e) => e.ok),
    [false, false, false, false],
  );
});

test("a found model is named local:<host>:<port>/<model>, and no other id can take that name", async () => {
  forgetLocalScan();
  const stub = machine({
    [OLLAMA]: { models: ["llama3.2:latest", "hf.co/org/Model-GGUF:Q4_K_M", "bad name!"] },
  });
  const env = { AUTH_MODE: "local", LOCAL_MODEL_ENDPOINTS: OLLAMA };
  await scanLocalModels({ env, fetchFor: stub.fetchFor });
  const found = serverModelList(env).filter((m) => m.detected);
  assert.deepEqual(
    found.map((m) => [m.id, m.name, m.provider, m.model, m.credentialVars]),
    [
      [
        "local:localhost:11434/hf.co/org/Model-GGUF:Q4_K_M",
        "local:localhost:11434/hf.co/org/Model-GGUF:Q4_K_M",
        "openai-compatible",
        "hf.co/org/Model-GGUF:Q4_K_M",
        {},
      ],
      [
        "local:localhost:11434/llama3.2:latest",
        "local:localhost:11434/llama3.2:latest",
        "openai-compatible",
        "llama3.2:latest",
        {},
      ],
    ],
  );
  // A request may name one, as it may name a declared model.
  for (const m of found) assert.ok(ModelId.safeParse(m.id).success, m.id);
  // Declared models are `env:<name>`, catalog models uuids: neither matches.
  assert.equal(endpointLabel("http://[::1]:11434/v1"), "--1:11434");
  assert.equal(endpointLabel("https://ollama.internal/v1"), "ollama.internal:443");
  assert.equal(detectedModelId("localhost:11434", "bad name!"), null);
  assert.ok(
    !ModelId.safeParse("local:localhost/llama").success,
    "a label carries its port",
  );
});

test("a dead, failing, slow, non-JSON or oversized endpoint is skipped and counted, and no reply is logged", async () => {
  forgetLocalScan();
  const endpoints = {
    "http://dead.test:1/v1": "dead",
    "http://failing.test:2/v1": { status: 500 },
    "http://slow.test:3/v1": "hang",
    "http://garbled.test:4/v1": { text: `<html>${REPLY_SECRET}</html>` },
    "http://huge.test:5/v1": { bytes: MAX_MODEL_LIST_BYTES + 1 },
    [OLLAMA]: { models: ["llama3.2"] },
  } satisfies Record<string, Behavior>;
  const stub = machine(endpoints);
  const env = {
    AUTH_MODE: "local",
    LOCAL_MODEL_ENDPOINTS: Object.keys(endpoints).join(", "),
  };
  const { lines, restore } = capturedLog();
  let scan: Awaited<ReturnType<typeof scanLocalModels>>;
  try {
    scan = await scanLocalModels({ env, fetchFor: stub.fetchFor, timeoutMs: 50 });
  } finally {
    restore();
  }
  assert.deepEqual(
    scan?.endpoints.map((e) => [e.host, e.ok, e.models]),
    [
      ["dead.test:1", false, []],
      ["failing.test:2", false, []],
      ["slow.test:3", false, []],
      ["garbled.test:4", false, []],
      ["huge.test:5", false, []],
      ["localhost:11434", true, ["llama3.2"]],
    ],
  );
  const detected = lines.filter(
    (l) => l.msg === "models.detected" || l.message === "models.detected",
  );
  assert.equal(detected.length, 1, JSON.stringify(lines));
  assert.equal(detected[0].endpoints, 6);
  assert.equal(detected[0].answered, 1);
  assert.equal(detected[0].skipped, 5);
  assert.equal(detected[0].models, 1);
  assert.deepEqual(detected[0].answeredHosts, ["localhost:11434"]);
  const text = JSON.stringify(lines);
  assert.ok(!text.includes(REPLY_SECRET), "a reply body reached the log");
  assert.ok(!text.includes("/v1"), "a full URL reached the log");
});

test("the probe and the models it finds reach the endpoints' hosts; a typed base URL still does not", async () => {
  forgetLocalScan();
  const env = {
    AUTH_MODE: "local",
    LOCAL_MODEL_ENDPOINTS: `${OLLAMA} http://host.docker.internal:1234/v1`,
  };
  const stub = machine({ [OLLAMA]: { models: ["llama3.2"] } });
  await scanLocalModels({ env, fetchFor: stub.fetchFor });
  for (const allowlist of stub.allowlists) {
    assert.equal(baseUrlShapeProblem(OLLAMA, allowlist), null);
    assert.equal(
      baseUrlShapeProblem("http://host.docker.internal:1234/v1", allowlist),
      null,
    );
    // Only the listed hosts: another private host is refused as ever.
    assert.match(
      String(baseUrlShapeProblem("http://10.0.0.5:11434/v1", allowlist)),
      /https/,
    );
  }
  // With detection off nothing is added: the same host is refused.
  const off = { ...env, LOCAL_MODEL_DETECT: "off" };
  assert.equal(detectionAllowlist(off), null);
  // A base URL typed in the app is held to AI_BASE_URL_ALLOWLIST alone,
  // whether detection is on or not.
  for (const e of [env, off]) {
    const typed = deps(e).allowlist;
    assert.match(String(baseUrlShapeProblem(OLLAMA, typed)), /AI_BASE_URL_ALLOWLIST/);
  }
});

test("one endpoint answering makes its first model the default, usable with no key", async () => {
  forgetLocalScan();
  const env = { AUTH_MODE: "local", LOCAL_MODEL_ENDPOINTS: `${OLLAMA}, ${LM_STUDIO}` };
  const stub = machine({ [OLLAMA]: { models: ["qwen2.5", "llama3.2"] } });
  const { lines, restore } = capturedLog();
  try {
    await scanLocalModels({ env, fetchFor: stub.fetchFor });
  } finally {
    restore();
  }
  const listing = await usableModels(owner, "local", deps(env));
  assert.equal(listing.defaultModel, "local:localhost:11434/llama3.2");
  assert.ok(
    !listing.models.some((m) => m.id === "env:default"),
    "the empty legacy entry gives way",
  );
  assert.match(JSON.stringify(lines), /"default":"local:localhost:11434\/llama3.2"/);
  assert.equal(serverModelProblem(env), null);
  const resolved = await requireModel(
    { identity: owner, workspaceId: "local" },
    deps(env),
  );
  assert.equal(resolved.id, "local:localhost:11434/llama3.2");
  assert.equal(resolved.modelId, "llama3.2");
  // The other one may be named by a request, as any server model may.
  const picked = await requireModel(
    { identity: owner, workspaceId: "local", modelId: "local:localhost:11434/qwen2.5" },
    deps(env),
  );
  assert.equal(picked.modelId, "qwen2.5");
});

test("with more than one endpoint answering, or a model of the server's own, none is the default", async () => {
  forgetLocalScan();
  const env = { AUTH_MODE: "local", LOCAL_MODEL_ENDPOINTS: `${OLLAMA}, ${LM_STUDIO}` };
  const stub = machine({
    [OLLAMA]: { models: ["llama3.2"] },
    [LM_STUDIO]: { models: ["qwen2.5-7b-instruct"] },
  });
  await scanLocalModels({ env, fetchFor: stub.fetchFor });
  const listing = await usableModels(owner, "local", deps(env));
  assert.equal(listing.defaultModel, "env:default");
  assert.deepEqual(
    listing.models.map((m) => m.id),
    [
      "env:default",
      "local:localhost:11434/llama3.2",
      "local:localhost:1234/qwen2.5-7b-instruct",
    ],
  );
  await assert.rejects(
    requireModel({ identity: owner, workspaceId: "local" }, deps(env)),
    /No model configured[\s\S]*Re-scan/,
  );

  forgetLocalScan();
  const own = { ...env, AI_MODEL: "gpt-5", OPENAI_API_KEY: "sk-own" };
  await scanLocalModels({
    env: own,
    fetchFor: machine({ [OLLAMA]: { models: ["llama3.2"] } }).fetchFor,
  });
  assert.equal(
    (await usableModels(owner, "local", deps(own))).defaultModel,
    "env:default",
  );
});
