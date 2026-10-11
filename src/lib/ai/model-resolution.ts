import { HttpError } from "@/lib/auth/authorize";
import type { Identity } from "@/lib/auth/claims";
import { aiConfigProblem, aiUnavailableMessage } from "@/lib/ai/configured";
import { type BaseUrlAllowlist, parseBaseUrlAllowlist } from "@/lib/ai/base-url";
import { checkBaseUrl } from "@/lib/ai/guarded-fetch";
import {
  credentialsNoun,
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
import {
  type Credentials,
  credentialFields,
  endpointOf,
  kindOf,
  originOf,
  parseCredentials,
} from "@/lib/ai/providers/registry";
import type { ProviderKind } from "@/lib/ai/providers/types";
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
 * Credentials are opened here and nowhere else, at the moment a model is
 * built, and every value is registered with the log's redaction
 * (`rememberSecret`) as it is, so none can appear in a log line, an audit row
 * or a generation log row even if a provider echoes it back in an error.
 */

/** The HKDF label for model credentials: a sealed refresh token never opens as one. */
const KEY_LABEL = "holotable model-api-key v1";

/**
 * Seal a kind's credentials (#438), or null when there are none. A lone
 * `apiKey` is sealed as the bare key, exactly as #331 wrote it, so a row
 * written now still opens under the previous version during a rolling
 * update; anything else is sealed as a JSON object under the same label.
 */
export function sealCredentials(
  credentials: Credentials,
  secret?: Uint8Array,
): Buffer | null {
  const entries = Object.entries(credentials).filter(([, value]) => value !== "");
  if (entries.length === 0) return null;
  const plaintext =
    entries.length === 1 && entries[0][0] === "apiKey"
      ? entries[0][1]
      : JSON.stringify(Object.fromEntries(entries));
  return sealSecret(plaintext, KEY_LABEL, secret);
}

type OpenedCredentials =
  | { state: "none" }
  | { state: "ok"; credentials: Credentials }
  | { state: "unreadable" };

/**
 * A plaintext as credentials: a JSON object of string values is the
 * object; anything else is a bare key, as #331 sealed it, read as
 * `{ apiKey }`. So no row written before #438 is re-sealed.
 */
function credentialsFromPlaintext(plaintext: string): Credentials {
  if (plaintext.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(plaintext);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        Object.values(parsed).every((v) => typeof v === "string")
      ) {
        return parsed as Credentials;
      }
    } catch {
      // Not JSON: a bare key that happens to start with a brace.
    }
  }
  return { apiKey: plaintext };
}

export function openCredentials(
  sealed: Buffer | null,
  secret?: Uint8Array,
): OpenedCredentials {
  if (!sealed) return { state: "none" };
  const plaintext = openSecret(sealed, KEY_LABEL, secret);
  if (plaintext === null) return { state: "unreadable" };
  const credentials = credentialsFromPlaintext(plaintext);
  for (const value of Object.values(credentials)) rememberSecret(value);
  return { state: "ok", credentials };
}

/**
 * May a model of the stub kind be saved? Outside production, or where the
 * operator said the server is the end-to-end suite's, as for the
 * environment's stub (`AI_STUB_IN_PRODUCTION`).
 */
export function stubAllowed(env: Environment = process.env): boolean {
  return env.NODE_ENV !== "production" || env.AI_STUB_IN_PRODUCTION === "true";
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

const MISSING_CREDENTIALS: Record<"personal" | "workspace", string> = {
  personal:
    "Your personal model has no usable credentials stored. Enter them again under Settings → Personal model.",
  workspace:
    "This workspace's model has no usable credentials stored. A source-admin must enter them again under Settings → Workspace model.",
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
  const opened = openCredentials(stored.credentials);
  if (opened.state === "unreadable") {
    return { ok: false, source, problem: UNREADABLE_KEY[source] };
  }
  const credentials = parseCredentials(
    kindOf(settings),
    opened.state === "ok" ? opened.credentials : {},
  );
  if (!credentials.ok) return { ok: false, source, problem: MISSING_CREDENTIALS[source] };
  return {
    ok: true,
    source,
    modelId: settings.model,
    model: configuredModel(settings, credentials.credentials, allowlist),
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

/**
 * Stored credentials as a page sees them: whether there are any, and the
 * last four characters of the first secret field the kind draws.
 */
function keyState(sealed: Buffer | null, settings: ModelSettings): KeyState {
  const opened = openCredentials(sealed);
  if (opened.state !== "ok") return opened;
  const first = credentialFields(kindOf(settings))
    .map((field) => opened.credentials[field.name])
    .find((value) => typeof value === "string" && value !== "");
  return { state: "set", hint: first ? keyHint(first) : null };
}

/** A stored configuration as the settings page sees it: never the key. */
export function configView(stored: StoredModelConfig): ModelConfigView | null {
  const settings = parseSettings(stored);
  if (!settings) return null;
  return {
    settings,
    key: keyState(stored.credentials, settings),
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
 * A typed base URL passes the address rules, DNS included. Credentials left
 * out of the request keep the stored ones, but only for the same origin:
 * keeping a key while pointing it at a different host would hand a key
 * nobody can read to whoever runs that host, so a new origin (another
 * provider, another Azure resource or AWS region, another base URL) needs
 * them entered again. Whatever is kept, cleared or entered must fit the
 * kind's credentials (a fixed vendor always needs its key).
 */
export async function prepareWrite(
  input: ModelConfigInput,
  current: StoredModelConfig | null,
  deps: ModelResolutionDeps = defaultModelDeps(),
): Promise<ModelConfigWrite> {
  const { settings } = input;
  const kind = kindOf(settings);
  if (kind.developmentOnly && !stubAllowed(deps.env)) {
    throw new HttpError(400, `${kind.label} is not available on a production server.`);
  }
  const endpoint = endpointOf(settings);
  if (kind.userSetsEndpoint && endpoint !== null) {
    const problem = await checkBaseUrl(endpoint, deps.allowlist);
    if (problem) throw new HttpError(400, problem);
  }

  let credentials: ModelConfigWrite["credentials"];
  if (input.credentials === undefined) {
    if (current?.credentials) {
      const previous = parseSettings(current);
      const sameOrigin = previous !== null && originOf(previous) === originOf(settings);
      if (!sameOrigin) {
        throw new HttpError(
          400,
          `Requests would go to a different host than the stored ${credentialsNoun(kind)} was entered for, so enter ${credentialsNoun(kind) === "key" ? "the API key" : "the credentials"} again (or leave ${credentialsNoun(kind) === "key" ? "it" : "them"} empty for an endpoint that needs none).`,
        );
      }
    } else {
      requireCredentials(kind, {});
    }
    credentials = "keep";
  } else if (input.credentials === null) {
    requireCredentials(kind, {});
    credentials = null;
  } else {
    const entered = requireCredentials(kind, input.credentials);
    credentials = sealCredentials(entered);
    for (const value of Object.values(entered)) rememberSecret(value);
  }

  const { provider, ...rest } = settings;
  return { provider, settings: rest, credentials };
}

/** Credentials held to the kind's shape, or a 400 naming the field. */
function requireCredentials(kind: ProviderKind, raw: unknown): Credentials {
  const parsed = parseCredentials(kind, raw);
  if (!parsed.ok) throw new HttpError(400, parsed.message);
  return parsed.credentials;
}

/**
 * A configuration as a model, for "Test connection": the one submitted, with
 * the stored credentials when the form left them out (same origin only, as
 * for a save).
 */
export async function modelForTest(
  input: ModelConfigInput,
  current: StoredModelConfig | null,
  deps: ModelResolutionDeps = defaultModelDeps(),
): Promise<Model> {
  const write = await prepareWrite(input, current, deps);
  let credentials: Credentials = {};
  if (write.credentials === "keep") {
    const opened = openCredentials(current?.credentials ?? null);
    if (opened.state === "unreadable") {
      throw new HttpError(
        400,
        "The stored credentials can no longer be read; enter them again.",
      );
    }
    if (opened.state === "ok")
      credentials = requireCredentials(kindOf(input.settings), opened.credentials);
  } else if (input.credentials) {
    credentials = requireCredentials(kindOf(input.settings), input.credentials);
  }
  return configuredModel(input.settings, credentials, deps.allowlist);
}
