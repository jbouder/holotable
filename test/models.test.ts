import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseBaseUrlAllowlist } from "@/lib/ai/base-url";
import {
  assertManages,
  createModel,
  deleteModel,
  listModels,
  personalOwner,
  saveWorkspaceModelSettings,
  updateModel,
  workspaceModelView,
  workspaceOwner,
} from "@/lib/ai/model-admin";
import { ModelId, type ModelInput, WorkspaceModelInput } from "@/lib/ai/model-config";
import { type ModelResolutionDeps, sealCredentials } from "@/lib/ai/model-resolution";
import { NOT_AVAILABLE, requireModel, resolveModel, usableModels } from "@/lib/ai/models";
import { HttpError } from "@/lib/auth/authorize";
import { parseGroups } from "@/lib/auth/claims";
import type { StoredModel } from "@/lib/db/models";
import { memoryModelStore, storedModel } from "./support/models";

/**
 * The model catalog (#439): what a caller may use in a workspace, which
 * model a request gets, and the writes behind the catalog routes.
 */

const NO_ALLOWLIST = parseBaseUrlAllowlist("");
const OTHER = new TextEncoder().encode("o".repeat(40));
const KEY = "sk-catalog-secret-0123456789";

const alice = parseGroups("alice", ["/workspaces/w/editor", "/workspaces/x/editor"]);
const admin = parseGroups("root", ["/workspaces/w/source-admin"]);
const robot = {
  ...parseGroups("robot", ["/workspaces/w/editor"]),
  serviceAccount: { tokenId: "1", name: "ci" },
};

const sealed = () => sealCredentials({ apiKey: KEY });
const wsModel = storedModel({ name: "Cheap", credentials: sealed() });
const strong = storedModel({
  name: "Strong",
  provider: "anthropic",
  settings: { model: "claude" },
  credentials: sealed(),
});
const foreign = storedModel({ workspaceId: "x", name: "Theirs", credentials: sealed() });
const mine = storedModel({
  scope: "personal",
  workspaceId: null,
  userSub: "alice",
  name: "Mine",
  settings: { baseUrl: "https://api.example.com/v1", model: "my-model", api: "chat" },
  credentials: sealed(),
});
const bobs = storedModel({
  scope: "personal",
  workspaceId: null,
  userSub: "bob",
  name: "Bob's",
});

function deps(
  options: {
    allowPersonalKeys?: boolean;
    defaultModel?: string | null;
    models?: StoredModel[];
    demo?: boolean;
    env?: Record<string, string>;
  } = {},
): ModelResolutionDeps & { store: ReturnType<typeof memoryModelStore> } {
  return {
    store: memoryModelStore({
      models: (options.models ?? [wsModel, strong, foreign, mine, bobs]).map((m) => ({
        ...m,
      })),
      workspaces: [
        {
          workspaceId: "w",
          defaultModel: options.defaultModel ?? null,
          allowPersonalKeys: options.allowPersonalKeys ?? false,
        },
      ],
    }),
    demo: options.demo ?? false,
    env: options.env ?? { AI_PROVIDER: "stub" },
    allowlist: NO_ALLOWLIST,
  };
}

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (err) {
    if (err instanceof HttpError) return err.status;
    throw err;
  }
}

/* --- The listing ----------------------------------------------------------- */

test("a listing holds the server's and the workspace's models, and personal ones only where allowed", async () => {
  const closed = await usableModels(alice, "w", deps());
  assert.deepEqual(
    closed.models.map((m) => [m.id, m.scope]),
    [
      ["env:default", "environment"],
      [wsModel.id, "workspace"],
      [strong.id, "workspace"],
    ],
  );
  const open = await usableModels(alice, "w", deps({ allowPersonalKeys: true }));
  assert.deepEqual(
    open.models.map((m) => m.name),
    ["default", "Cheap", "Strong", "Mine"],
  );
  // Never another person's, never another workspace's.
  assert.ok(!open.models.some((m) => m.id === bobs.id || m.id === foreign.id));
});

test("a listing names models and nothing more: no settings beyond the model id, no credentials", async () => {
  const listing = await usableModels(alice, "w", deps({ allowPersonalKeys: true }));
  const text = JSON.stringify(listing);
  assert.ok(!text.includes(KEY));
  assert.ok(!text.includes("credentials"));
  assert.ok(!text.includes("api.example.com"));
  assert.deepEqual(Object.keys(listing.models[1]).sort(), [
    "id",
    "model",
    "name",
    "provider",
    "scope",
    "unavailable",
  ]);
});

test("a service-account token and demo mode see no personal models", async () => {
  const robotView = await usableModels(robot, "w", deps({ allowPersonalKeys: true }));
  assert.ok(!robotView.models.some((m) => m.scope === "personal"));
  const demo = await usableModels(
    alice,
    "w",
    deps({ allowPersonalKeys: true, demo: true }),
  );
  assert.deepEqual(
    demo.models.map((m) => m.id),
    ["env:default"],
  );
});

test("a broken model is listed with its reason, never its credentials", async () => {
  const rotated = { ...wsModel, credentials: sealCredentials({ apiKey: KEY }, OTHER) };
  const listing = await usableModels(alice, "w", deps({ models: [rotated] }));
  assert.match(listing.models[1].unavailable ?? "", /can no longer be read/);
});

/* --- Resolution ------------------------------------------------------------ */

test("a request names a model by id, and only one the catalog grants here", async () => {
  const d = deps({ allowPersonalKeys: false });
  const chosen = await resolveModel(
    { identity: alice, workspaceId: "w", modelId: strong.id },
    d,
  );
  assert.equal(chosen.ok, true);
  assert.equal(chosen.id, strong.id);
  assert.equal(chosen.ok && chosen.modelId, "claude");
  assert.equal(chosen.source, "workspace");

  const server = await resolveModel(
    { identity: alice, workspaceId: "w", modelId: "env:default" },
    d,
  );
  assert.equal(server.source, "environment");

  for (const modelId of [
    mine.id, // personal, in a workspace that does not allow them
    foreign.id, // another workspace's
    bobs.id, // another person's
    "00000000-0000-4000-8000-000000000000", // deleted or never existed
    "env:nope",
  ]) {
    await assert.rejects(
      resolveModel({ identity: alice, workspaceId: "w", modelId }, d),
      (err: unknown) =>
        err instanceof HttpError && err.status === 400 && err.message === NOT_AVAILABLE,
      modelId,
    );
  }
  const allowed = await resolveModel(
    { identity: alice, workspaceId: "w", modelId: mine.id },
    deps({ allowPersonalKeys: true }),
  );
  assert.equal(allowed.source, "personal");
});

test("without a pick: a personal model where allowed, then the workspace's default, then the server's", async () => {
  const none = await resolveModel({ identity: alice, workspaceId: "w" }, deps());
  assert.equal(none.id, "env:default");

  const byDefault = await resolveModel(
    { identity: alice, workspaceId: "w" },
    deps({ defaultModel: strong.id }),
  );
  assert.equal(byDefault.id, strong.id);

  const personal = await resolveModel(
    { identity: alice, workspaceId: "w" },
    deps({ defaultModel: strong.id, allowPersonalKeys: true }),
  );
  assert.equal(personal.id, mine.id);

  // A default that no longer exists falls to the server's.
  const stale = await resolveModel(
    { identity: alice, workspaceId: "w" },
    deps({ defaultModel: "00000000-0000-4000-8000-000000000000" }),
  );
  assert.equal(stale.id, "env:default");

  const listing = await usableModels(alice, "w", deps({ defaultModel: strong.id }));
  assert.equal(listing.defaultModel, strong.id);
});

test("a default whose credentials cannot be read is a 503 with the reason, never another model", async () => {
  const rotated = { ...strong, credentials: sealCredentials({ apiKey: KEY }, OTHER) };
  await assert.rejects(
    requireModel(
      { identity: alice, workspaceId: "w" },
      deps({ models: [rotated], defaultModel: rotated.id }),
    ),
    (err: unknown) =>
      err instanceof HttpError &&
      err.status === 503 &&
      /can no longer be read/.test(err.message),
  );
});

test("demo mode resolves the server's model only", async () => {
  const d = deps({ demo: true, defaultModel: strong.id, allowPersonalKeys: true });
  assert.equal(
    (await resolveModel({ identity: alice, workspaceId: "w" }, d)).id,
    "env:default",
  );
  assert.equal(
    await status(
      resolveModel({ identity: alice, workspaceId: "w", modelId: strong.id }, d),
    ),
    400,
  );
});

/* --- Writes ---------------------------------------------------------------- */

const input = (name: string, apiKey?: string): ModelInput => ({
  name,
  settings: { provider: "anthropic", model: "claude" },
  ...(apiKey ? { credentials: { apiKey } } : {}),
});

test("a model is created, renamed, kept and deleted within its owner only", async () => {
  const d = deps({ models: [] });
  const owner = workspaceOwner("w");
  const created = await createModel(owner, input("Claude", KEY), "root", d);
  assert.equal(created.name, "Claude");
  assert.deepEqual(created.key, { state: "set", hint: "6789" });
  assert.ok(!JSON.stringify(created).includes(KEY));

  assert.equal(await status(createModel(owner, input("claude", KEY), "root", d)), 409);

  const renamed = await updateModel(owner, created.id, input("Claude 2"), "root", d);
  assert.equal(renamed.name, "Claude 2");
  assert.deepEqual(renamed.key, { state: "set", hint: "6789" });

  // Another workspace, or a person, cannot reach it by id.
  assert.equal(
    await status(updateModel(workspaceOwner("x"), created.id, input("Mine"), "eve", d)),
    404,
  );
  assert.equal(await status(deleteModel(personalOwner(alice), created.id, d)), 404);

  await saveWorkspaceModelSettings(
    "w",
    { defaultModel: created.id, allowPersonalKeys: false },
    "root",
    d,
  );
  await deleteModel(owner, created.id, d);
  const after = await workspaceModelView("w", d);
  assert.equal(after.defaultModel, null, "deleting the default clears it");
  assert.deepEqual(after.models, []);
});

test("a model that needs no credentials is created without any", async () => {
  const d = deps({ models: [] });
  const stub = await createModel(
    workspaceOwner("w"),
    { name: "Stub", settings: { provider: "stub", model: "stub" } },
    "root",
    d,
  );
  assert.deepEqual(stub.key, { state: "none" });
  const local = await createModel(
    personalOwner(alice),
    {
      name: "Local",
      settings: {
        provider: "openai-compatible",
        baseUrl: "https://93.184.216.34/v1",
        model: "llama3",
        api: "chat",
      },
    },
    "alice",
    d,
  );
  assert.deepEqual(local.key, { state: "none" });
});

test("a workspace's default is one of its own models or a server model", async () => {
  const d = deps();
  for (const defaultModel of [foreign.id, mine.id, "env:nope"]) {
    assert.equal(
      await status(
        saveWorkspaceModelSettings(
          "w",
          { defaultModel, allowPersonalKeys: true },
          "root",
          d,
        ),
      ),
      400,
      defaultModel,
    );
  }
  const view = await saveWorkspaceModelSettings(
    "w",
    { defaultModel: "env:default", allowPersonalKeys: true },
    "root",
    d,
  );
  assert.equal(view.defaultModel, "env:default");
  assert.equal(view.config, null);
  const own = await saveWorkspaceModelSettings(
    "w",
    { defaultModel: strong.id, allowPersonalKeys: true },
    "root",
    d,
  );
  assert.equal(own.config?.id, strong.id);
  assert.ok(!JSON.stringify(own).includes(KEY));
  assert.equal(
    WorkspaceModelInput.safeParse({ defaultModel: "x", allowPersonalKeys: true }).success,
    false,
  );
  assert.equal(ModelId.safeParse("env:Default!").success, false);
});

test("demo mode refuses every write", async () => {
  const d = deps({ demo: true, models: [] });
  assert.equal(
    await status(createModel(workspaceOwner("w"), input("A", KEY), "root", d)),
    403,
  );
  assert.equal(
    await status(
      saveWorkspaceModelSettings(
        "w",
        { defaultModel: null, allowPersonalKeys: true },
        "root",
        d,
      ),
    ),
    403,
  );
});

test("personal models are the caller's own, and a service-account token has none", async () => {
  const d = deps();
  assert.deepEqual(
    (await listModels(personalOwner(alice), d)).map((m) => m.name),
    ["Mine"],
  );
  assert.throws(
    () => personalOwner(robot),
    (err: unknown) => err instanceof HttpError && err.status === 403,
  );
});

test("the workspace routes require source:manage", () => {
  assert.throws(
    () => assertManages(alice, "w"),
    (err: unknown) => err instanceof HttpError && err.status === 403,
  );
  assert.doesNotThrow(() => assertManages(admin, "w"));
});

/* --- Every catalog route takes the checks ---------------------------------- */

const ROOT = new URL("..", import.meta.url).pathname;

function routes(dir: string): Array<{ path: string; text: string }> {
  const found: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const path = join(d, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry === "route.ts") found.push(path);
    }
  };
  walk(join(ROOT, dir));
  return found.map((path) => ({
    path: relative(ROOT, path),
    text: readFileSync(path, "utf8"),
  }));
}

test("every workspace model route checks source:manage, every personal one refuses a service account", () => {
  const workspace = [
    ...routes("src/app/api/workspaces/[id]/models"),
    ...routes("src/app/api/workspaces/[id]/model"),
  ];
  assert.ok(workspace.length >= 4);
  for (const { path, text } of workspace) {
    const handlers = text.match(/export const (GET|POST|PUT|DELETE)/g) ?? [];
    const checks = text.match(/assertManages\(identity, workspaceId\)/g) ?? [];
    assert.equal(
      checks.length,
      handlers.length,
      `${path}: a handler without assertManages`,
    );
  }
  const personal = routes("src/app/api/me/models");
  assert.ok(personal.length >= 3);
  for (const { path, text } of personal) {
    const handlers = text.match(/export const (GET|POST|PUT|DELETE)/g) ?? [];
    const checks = text.match(/personalOwner\(identity\)/g) ?? [];
    assert.equal(
      checks.length,
      handlers.length,
      `${path}: a handler without personalOwner`,
    );
  }
});

/* --- The pick (#442) ------------------------------------------------------- */

function picks(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  const remembered: Array<[string, string, string]> = [];
  return {
    remembered,
    picks: {
      get: async (sub: string, workspaceId: string) =>
        store.get(`${sub}/${workspaceId}`) ?? null,
      remember: async (sub: string, workspaceId: string, modelId: string) => {
        remembered.push([sub, workspaceId, modelId]);
        store.set(`${sub}/${workspaceId}`, modelId);
      },
    },
  };
}

test("without a pick: the conversation's model, then the last pick, while each is usable", async () => {
  const { picks: remembered } = picks({ "alice/w": strong.id });
  const d = { ...deps({ defaultModel: wsModel.id }), picks: remembered };
  const input = { identity: alice, workspaceId: "w" };
  assert.equal((await resolveModel(input, d)).id, strong.id, "the last pick");
  assert.equal(
    (await resolveModel({ ...input, preferred: "env:default" }, d)).id,
    "env:default",
    "the conversation's own model",
  );
  // A stored id that is no longer usable is passed over, never refused.
  assert.equal(
    (await resolveModel({ ...input, preferred: foreign.id }, d)).id,
    strong.id,
  );
  const gone = {
    ...deps({ defaultModel: wsModel.id }),
    picks: picks({ "alice/w": foreign.id }).picks,
  };
  assert.equal((await resolveModel(input, gone)).id, wsModel.id);
  // The listing's default says the same.
  assert.equal((await usableModels(alice, "w", d)).defaultModel, strong.id);
});

test("a named model is remembered for the person and the workspace, never for a token", async () => {
  const { picks: store, remembered } = picks();
  const d = { ...deps(), picks: store };
  await requireModel({ identity: alice, workspaceId: "w", modelId: strong.id }, d);
  await requireModel({ identity: alice, workspaceId: "w" }, d);
  await requireModel({ identity: robot, workspaceId: "w", modelId: strong.id }, d);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(remembered, [["alice", "w", strong.id]]);
  // A refused id remembers nothing.
  await assert.rejects(
    requireModel({ identity: alice, workspaceId: "w", modelId: foreign.id }, d),
  );
  assert.equal(remembered.length, 1);
});
