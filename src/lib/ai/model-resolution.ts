import { HttpError } from "@/lib/auth/authorize";
import type { Identity } from "@/lib/auth/claims";
import { aiConfigProblem, aiUnavailableMessage } from "@/lib/ai/configured";
import { type BaseUrlAllowlist, parseBaseUrlAllowlist } from "@/lib/ai/base-url";
import { checkBaseUrl } from "@/lib/ai/guarded-fetch";
import {
  type EffectiveModel,
  type KeyState,
  keyHint,
  type ModelConfigInput,
  type ModelConfigView,
  ModelSettings,
  type ModelSource,
  type WorkspaceModelView,
} from "@/lib/ai/model-config";
import { configuredModel, getModel, type Model } from "@/lib/ai/provider";
import { config, type Environment } from "@/lib/config";
import {
  type ModelConfigStore,
  type ModelConfigWrite,
  pgModelConfigStore,
  type StoredModelConfig,
} from "@/lib/db/model-configs";
import { rememberSecret } from "@/lib/log";
import { openSecret, sealSecret } from "@/lib/secrets/seal";

/**
 * Which model a generation uses (#331), and the server half of configuring
 * one in the app. See `model-config.ts` for the resolution order.
 *
 * A key is opened here and nowhere else, at the moment a model is built, and
 * is registered with the log's redaction (`rememberSecret`) as it is, so the
 * key cannot appear in a log line, an audit row or a generation log row even
 * if a provider echoes it back in an error.
 */

/** The HKDF label for model keys: a sealed refresh token never opens as one. */
const KEY_LABEL = "holotable model-api-key v1";

export function sealModelKey(key: string, secret?: Uint8Array): Buffer {
  return sealSecret(key, KEY_LABEL, secret);
}

type OpenedKey =
  | { state: "none" }
  | { state: "ok"; key: string }
  | { state: "unreadable" };

export function openModelKey(sealed: Buffer | null, secret?: Uint8Array): OpenedKey {
  if (!sealed) return { state: "none" };
  const key = openSecret(sealed, KEY_LABEL, secret);
  if (key === null) return { state: "unreadable" };
  rememberSecret(key);
  return { state: "ok", key };
}

export interface ModelResolutionDeps {
  store: ModelConfigStore;
  /** `AUTH_MODE=demo` turns both in-app levels off. */
  demo: boolean;
  env: Environment;
  allowlist: BaseUrlAllowlist;
}

let defaultAllowlist: BaseUrlAllowlist | undefined;

export function defaultModelDeps(): ModelResolutionDeps {
  defaultAllowlist ??= parseBaseUrlAllowlist(config.aiBaseUrlAllowlist);
  return {
    store: pgModelConfigStore,
    demo: config.authMode === "demo",
    env: process.env,
    allowlist: defaultAllowlist,
  };
}

export type ResolvedModel =
  | { ok: true; source: ModelSource; modelId: string; model: Model }
  | { ok: false; source: ModelSource; problem: string };

const UNREADABLE_SETTINGS: Record<"personal" | "workspace", string> = {
  personal:
    "Your personal model configuration can no longer be read. Save it again under Settings → Personal model.",
  workspace:
    "This workspace's model configuration can no longer be read. A source-admin must save it again under Settings → Workspace model.",
};

const UNREADABLE_KEY: Record<"personal" | "workspace", string> = {
  personal:
    "Your personal model key can no longer be read, because the server's SESSION_SECRET changed. Enter it again under Settings → Personal model.",
  workspace:
    "This workspace's model key can no longer be read, because the server's SESSION_SECRET changed. A source-admin must enter it again under Settings → Workspace model.",
};

function parseSettings(stored: StoredModelConfig): ModelSettings | null {
  const parsed = ModelSettings.safeParse({
    ...(stored.settings as object),
    provider: stored.provider,
  });
  return parsed.success ? parsed.data : null;
}

/** A stored level as a model, or why it cannot be one. Builds nothing that calls out. */
function fromStored(
  source: "personal" | "workspace",
  stored: StoredModelConfig,
  allowlist: BaseUrlAllowlist,
): ResolvedModel {
  const settings = parseSettings(stored);
  if (!settings) return { ok: false, source, problem: UNREADABLE_SETTINGS[source] };
  const key = openModelKey(stored.apiKey);
  if (key.state === "unreadable") {
    return { ok: false, source, problem: UNREADABLE_KEY[source] };
  }
  return {
    ok: true,
    source,
    modelId: settings.model,
    model: configuredModel(settings, key.state === "ok" ? key.key : null, allowlist),
  };
}

function fromEnvironment(env: Environment): ResolvedModel {
  const problem = aiConfigProblem(env);
  if (problem) {
    return { ok: false, source: "environment", problem: aiUnavailableMessage(problem) };
  }
  return {
    ok: true,
    source: "environment",
    modelId: env.AI_MODEL ?? "",
    model: getModel(),
  };
}

/**
 * The model for a generation by `identity` in `workspaceId`: the first level
 * that is configured, even when it is broken. A broken workspace key is
 * reported, never silently replaced by the environment's model, which may be
 * billed to someone else.
 */
export async function resolveModel(
  input: { identity: Identity; workspaceId: string },
  deps: ModelResolutionDeps = defaultModelDeps(),
): Promise<ResolvedModel> {
  if (deps.demo) return fromEnvironment(deps.env);
  const [workspace, personal] = await Promise.all([
    deps.store.workspace(input.workspaceId),
    deps.store.user(input.identity.sub),
  ]);
  if (personal && workspace?.allowPersonalKeys) {
    return fromStored("personal", personal, deps.allowlist);
  }
  if (workspace?.config) return fromStored("workspace", workspace.config, deps.allowlist);
  return fromEnvironment(deps.env);
}

/** {@link resolveModel}, or a 503 that says what to configure. For the generation routes. */
export async function requireModel(
  input: { identity: Identity; workspaceId: string },
  deps?: ModelResolutionDeps,
): Promise<Extract<ResolvedModel, { ok: true }>> {
  const resolved = await resolveModel(input, deps);
  if (!resolved.ok) throw new HttpError(503, resolved.problem);
  return resolved;
}

/** What a page shows about the model a generation here would use. */
export async function effectiveModel(
  input: { identity: Identity; workspaceId: string },
  deps?: ModelResolutionDeps,
): Promise<EffectiveModel> {
  const resolved = await resolveModel(input, deps);
  return resolved.ok
    ? { source: resolved.source, model: resolved.modelId, unavailable: null }
    : { source: resolved.source, model: "", unavailable: resolved.problem };
}

/** {@link effectiveModel} for each workspace, keyed by id. */
export async function effectiveModels(
  identity: Identity,
  workspaceIds: readonly string[],
  deps?: ModelResolutionDeps,
): Promise<Record<string, EffectiveModel>> {
  const entries = await Promise.all(
    [...new Set(workspaceIds)].map(
      async (workspaceId) =>
        [workspaceId, await effectiveModel({ identity, workspaceId }, deps)] as const,
    ),
  );
  return Object.fromEntries(entries);
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                   */
/* -------------------------------------------------------------------------- */

function keyState(sealed: Buffer | null): KeyState {
  const opened = openModelKey(sealed);
  if (opened.state === "ok") return { state: "set", hint: keyHint(opened.key) };
  return opened;
}

/** A stored configuration as the settings page sees it: never the key. */
export function configView(stored: StoredModelConfig): ModelConfigView | null {
  const settings = parseSettings(stored);
  if (!settings) return null;
  return {
    settings,
    key: keyState(stored.apiKey),
    updatedBy: stored.updatedBy,
    updatedAt: stored.updatedAt,
  };
}

export async function workspaceModelView(
  workspaceId: string,
  deps: ModelResolutionDeps = defaultModelDeps(),
): Promise<WorkspaceModelView> {
  const record = await deps.store.workspace(workspaceId);
  return {
    workspaceId,
    config: record?.config ? configView(record.config) : null,
    allowPersonalKeys: record?.allowPersonalKeys ?? false,
  };
}

/** May a configuration be saved at all? Demo mode has the environment's model only. */
export function assertConfigurable(deps: ModelResolutionDeps = defaultModelDeps()): void {
  if (deps.demo) {
    throw new HttpError(
      403,
      "Model configuration is turned off in demo mode; the server's own model is the only one.",
    );
  }
}

/**
 * Hold a configuration to the rules and turn it into the row to write.
 *
 * The base URL passes the address rules, DNS included. A key left out of the
 * request keeps the stored one, but only for the same origin: keeping a key
 * while pointing it at a different host would hand a key nobody can read to
 * whoever runs that host, so a new origin needs the key entered again.
 */
export async function prepareWrite(
  input: ModelConfigInput,
  current: StoredModelConfig | null,
  deps: ModelResolutionDeps = defaultModelDeps(),
): Promise<ModelConfigWrite> {
  const { settings } = input;
  const problem = await checkBaseUrl(settings.baseUrl, deps.allowlist);
  if (problem) throw new HttpError(400, problem);

  let apiKey: ModelConfigWrite["apiKey"];
  if (input.apiKey === undefined) {
    const previous = current ? parseSettings(current) : null;
    const sameOrigin =
      previous !== null &&
      new URL(previous.baseUrl).origin === new URL(settings.baseUrl).origin;
    if (current?.apiKey && !sameOrigin) {
      throw new HttpError(
        400,
        "The base URL's host changed, so enter the API key again (or leave it empty for an endpoint that needs none).",
      );
    }
    apiKey = "keep";
  } else {
    const key = input.apiKey.trim();
    apiKey = key === "" ? null : sealModelKey(key);
    if (key !== "") rememberSecret(key);
  }

  const { provider, ...rest } = settings;
  return { provider, settings: rest, apiKey };
}

/**
 * A configuration as a model, for "Test connection": the one submitted, with
 * the stored key when the form left it out (same origin only, as for a save).
 */
export async function modelForTest(
  input: ModelConfigInput,
  current: StoredModelConfig | null,
  deps: ModelResolutionDeps = defaultModelDeps(),
): Promise<Model> {
  const write = await prepareWrite(input, current, deps);
  let key: string | null = null;
  if (write.apiKey === "keep") {
    const opened = openModelKey(current?.apiKey ?? null);
    if (opened.state === "unreadable") {
      throw new HttpError(400, "The stored key can no longer be read; enter it again.");
    }
    key = opened.state === "ok" ? opened.key : null;
  } else if (input.apiKey?.trim()) {
    key = input.apiKey.trim();
  }
  return configuredModel(input.settings, key, deps.allowlist);
}
