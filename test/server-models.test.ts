import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBaseUrlAllowlist } from "@/lib/ai/base-url";
import type { ModelResolutionDeps } from "@/lib/ai/model-resolution";
import { requireModel, usableModels } from "@/lib/ai/models";
import { ModelSettings } from "@/lib/ai/model-config";
import { fetchFor } from "@/lib/ai/providers/server/registry";
import {
  forgetServerModelFiles,
  serverModelList,
  serverModelProblem,
} from "@/lib/ai/server-model-list";
import { checkServerModels, parseServerModels } from "@/lib/ai/server-models";
import { parseGroups } from "@/lib/auth/claims";
import { validateConfig } from "@/lib/config";
import { validateServerModelsFile } from "@/lib/startup";
import { memoryModelStore } from "./support/models";

/**
 * Server-managed models (#440): `AI_MODELS_FILE` declares the server's
 * models; the legacy variables stay one implicit entry named `default`.
 */

const dir = mkdtempSync(join(tmpdir(), "holotable-models-"));
let files = 0;
function file(content: unknown): string {
  const path = join(dir, `models-${++files}.json`);
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

const TWO = {
  models: [
    {
      name: "local",
      provider: "openai-compatible",
      model: "llama3",
      baseUrl: "http://ollama.internal:11434/v1",
      api: "chat",
    },
    {
      name: "claude",
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      credentials: { apiKey: "ANTHROPIC_API_KEY" },
      default: true,
    },
  ],
};

const alice = parseGroups("alice", ["/workspaces/w/editor"]);

function deps(env: Record<string, string>): ModelResolutionDeps {
  return {
    store: memoryModelStore(),
    demo: false,
    env,
    allowlist: parseBaseUrlAllowlist(""),
  };
}

test("a file with two entries lists two server models, the declared default first", async () => {
  forgetServerModelFiles();
  const env = { AI_MODELS_FILE: file(TWO), ANTHROPIC_API_KEY: "sk-ant-server" };
  const listing = await usableModels(alice, "w", deps(env));
  assert.deepEqual(
    listing.models.map((m) => [m.id, m.provider, m.model, m.unavailable]),
    [
      ["env:claude", "anthropic", "claude-sonnet-5-5", null],
      ["env:local", "openai-compatible", "llama3", null],
    ],
  );
  assert.equal(listing.defaultModel, "env:claude");
  assert.ok(!JSON.stringify(listing).includes("sk-ant-server"));
  assert.ok(!JSON.stringify(listing).includes("ollama.internal"));
});

test("with the legacy variables also set there are three, and the file's default wins", async () => {
  forgetServerModelFiles();
  const env = {
    AI_MODELS_FILE: file(TWO),
    ANTHROPIC_API_KEY: "sk-ant-server",
    AI_MODEL: "gpt-4o-mini",
    OPENAI_API_KEY: "sk-legacy",
  };
  const listing = await usableModels(alice, "w", deps(env));
  assert.deepEqual(
    listing.models.map((m) => m.id),
    ["env:claude", "env:local", "env:default"],
  );
  // Without a declared default the legacy model is the default.
  const undeclared = {
    models: TWO.models.map(({ default: _, ...m }) => m),
  };
  const fallback = serverModelList({ ...env, AI_MODELS_FILE: file(undeclared) });
  assert.equal(fallback[0].id, "env:default");
  // And without either, the file's first entry.
  const first = serverModelList({ AI_MODELS_FILE: file(undeclared) });
  assert.equal(first[0].id, "env:local");
});

test("only the legacy variables: one server model named default, answering as before", async () => {
  forgetServerModelFiles();
  const listing = await usableModels(alice, "w", deps({}));
  assert.deepEqual(
    listing.models.map((m) => [m.id, m.name]),
    [["env:default", "default"]],
  );
  await assert.rejects(
    requireModel({ identity: alice, workspaceId: "w" }, deps({})),
    /^HttpError: No model configured\. Set AI_MODEL and OPENAI_API_KEY on the server to generate with AI\.$/,
  );
  assert.equal(serverModelProblem({}), "AI_MODEL is not set");
  assert.equal(serverModelProblem({ AI_MODEL: "m", OPENAI_API_KEY: "k" }), null);
});

test("a variable the file names but the server lacks leaves the model listed and unavailable", async () => {
  forgetServerModelFiles();
  const env = { AI_MODELS_FILE: file(TWO) };
  const [claude] = serverModelList(env);
  assert.match(claude.unavailable ?? "", /^ANTHROPIC_API_KEY is not set on the server/);
  assert.deepEqual(claude.credentialVars, { apiKey: "ANTHROPIC_API_KEY" });
  assert.match(serverModelProblem(env) ?? "", /ANTHROPIC_API_KEY/);
  await assert.rejects(
    requireModel({ identity: alice, workspaceId: "w" }, deps(env)),
    /ANTHROPIC_API_KEY is not set/,
  );
  // The other entry needs no key and is still usable by id.
  const local = await requireModel(
    { identity: alice, workspaceId: "w", modelId: "env:local" },
    deps(env),
  );
  assert.equal(local.modelId, "llama3");
});

/* --- What the file may say ------------------------------------------------- */

const problemsOf = (content: unknown) =>
  parseServerModels(typeof content === "string" ? content : JSON.stringify(content))
    .problems;

test("each malformed shape is refused with a message naming the entry and the field", () => {
  const entry = (extra: Record<string, unknown>) => ({
    models: [
      {
        name: "a",
        provider: "openai",
        model: "gpt",
        credentials: { apiKey: "K" },
        ...extra,
      },
    ],
  });
  const cases: Array<[unknown, RegExp]> = [
    ["{not json", /not valid JSON/],
    [{ models: "no" }, /"models" list/],
    [{ models: [{ provider: "openai", model: "m" }] }, /^entry 1: "name"/],
    [entry({ name: "Has Caps" }), /"name" must be/],
    [entry({ provider: "cohere" }), /^entry "a": "provider" must name a provider kind/],
    [entry({ model: "" }), /^entry "a": "model"/],
    [entry({ baseUrl: "https://x" }), /^entry "a": OpenAI takes no "baseUrl"/],
    [entry({ default: "yes" }), /"default" must be true or false/],
    [
      entry({ credentials: { apiKey: "sk-live-0123456789" } }),
      /"credentials.apiKey" must be the name of an environment variable/,
    ],
    [
      entry({ credentials: { token: "TOKEN" } }),
      /"credentials.token" is not one of OpenAI's fields/,
    ],
    [entry({ credentials: {} }), /must name a variable for "apiKey"/],
    [
      { models: [entry({}).models[0], { ...entry({}).models[0] }] },
      /^entry "a": another entry has the same name/,
    ],
    [
      {
        models: [
          { ...entry({}).models[0], default: true },
          { ...entry({}).models[0], name: "b", default: true },
        ],
      },
      /more than one entry says "default": true \("a", "b"\)/,
    ],
  ];
  for (const [content, expected] of cases) {
    const problems = problemsOf(content);
    assert.equal(
      problems.length,
      1,
      `${JSON.stringify(content)}: ${problems.join(" | ")}`,
    );
    assert.match(problems[0], expected);
  }
  // A key pasted where a variable name belongs is never repeated back.
  assert.ok(
    !problemsOf(entry({ credentials: { apiKey: "sk-live-0123456789" } }))[0].includes(
      "sk-live",
    ),
  );
});

test("Bedrock names a variable for each half of its key pair", () => {
  const bedrock = {
    models: [
      {
        name: "bedrock",
        provider: "bedrock",
        region: "us-east-1",
        model: "anthropic.claude",
        credentials: {
          accessKeyId: "AWS_ACCESS_KEY_ID",
          secretAccessKey: "AWS_SECRET_ACCESS_KEY",
        },
      },
    ],
  };
  const parsed = parseServerModels(JSON.stringify(bedrock));
  assert.deepEqual(parsed.problems, []);
  assert.equal(parsed.entries[0].id, "env:bedrock");
});

test("the boot check: unset variables warn in development and fail in production", () => {
  const text = JSON.stringify(TWO);
  const dev = checkServerModels(text, {}, false);
  assert.deepEqual(
    dev.map((p) => [p.severity, p.message]),
    [
      [
        "warning",
        'entry "claude": ANTHROPIC_API_KEY is not set, so the model cannot be called.',
      ],
    ],
  );
  assert.equal(checkServerModels(text, {}, true)[0].severity, "error");
  assert.equal(
    checkServerModels(text, { AUTH_MODE: "demo" }, true)[0].severity,
    "warning",
  );
  assert.deepEqual(checkServerModels(text, { ANTHROPIC_API_KEY: "k" }, true), []);

  const named = JSON.stringify({ models: [{ name: "default", provider: "stub" }] });
  assert.ok(
    checkServerModels(named, { AI_MODEL: "m" }, false).some((p) =>
      /name is taken by the model AI_PROVIDER\/AI_MODEL describe/.test(p.message),
    ),
  );
  assert.ok(
    checkServerModels(named, {}, true).some(
      (p) => p.severity === "error" && /is the stub/.test(p.message),
    ),
  );
});

test("a file that cannot be read is an error, and the legacy variables become optional", () => {
  const missing = validateServerModelsFile(
    { AI_MODELS_FILE: join(dir, "nope.json") },
    false,
  );
  assert.equal(missing[0].severity, "error");
  assert.match(missing[0].message, /could not be read \(ENOENT\)/);

  const path = file(TWO);
  const withFile = validateConfig({ AI_MODELS_FILE: path }, { production: false });
  assert.ok(
    !withFile.some((p) => p.variable === "AI_MODEL" || p.variable === "OPENAI_API_KEY"),
  );
  const without = validateConfig({}, { production: false });
  assert.ok(without.some((p) => p.variable === "AI_MODEL"));
  // Legacy variables that name a model are still checked beside a file.
  const partial = validateConfig(
    { AI_MODELS_FILE: path, AI_MODEL: "m" },
    { production: false },
  );
  assert.ok(partial.some((p) => p.variable === "OPENAI_API_KEY"));
});

test("an operator's base URL is not held to the address rules, but still to its origin", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const settings = ModelSettings.parse({
      provider: "openai-compatible",
      baseUrl: `${origin}/v1`,
      model: "m",
    });
    const none = parseBaseUrlAllowlist("");
    const operator = fetchFor(settings, none, true);
    assert.equal((await operator(`${origin}/v1/models`)).status, 200);
    await assert.rejects(operator("http://127.0.0.2/v1"), /not the provider's/);
    // The same URL typed into the app is refused.
    await assert.rejects(fetchFor(settings, none, false)(`${origin}/v1/models`));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
