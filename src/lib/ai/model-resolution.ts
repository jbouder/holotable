import { HttpError } from "@/lib/auth/authorize";
import { aiConfigProblem, aiUnavailableMessage } from "@/lib/ai/configured";
import { type BaseUrlAllowlist, parseBaseUrlAllowlist } from "@/lib/ai/base-url";
import { checkBaseUrl } from "@/lib/ai/guarded-fetch";
import {
  credentialsNoun,
  type KeyState,
  keyHint,
  type ModelConfigInput,
  type ModelConfigView,
  ModelSettings,
  type ModelSource,
  type ModelView,
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
  type ModelStore,
  type ModelWrite,
  pgModelStore,
  type StoredModel,
} from "@/lib/db/models";
import { getUserPreferences, rememberModelPick } from "@/lib/db/repo";
import { rememberSecret } from "@/lib/log";
import { parsePreferences } from "@/lib/preferences";
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

/** What a stored model is built from: its kind, its settings, its sealed credentials. */
export type StoredConfig = Pick<StoredModel, "provider" | "settings" | "credentials">;

/**
 * The model a person last picked in each workspace (#442), kept in their
 * preferences. Read to choose a default; written when a request names one.
 */
export interface ModelPicks {
  get(sub: string, workspaceId: string): Promise<string | null>;
  remember(sub: string, workspaceId: string, modelId: string): Promise<void>;
}

export const pgModelPicks: ModelPicks = {
  async get(sub, workspaceId) {
    const prefs = parsePreferences(await getUserPreferences(sub));
    return prefs.modelByWorkspace[workspaceId] ?? null;
  },
  async remember(sub, workspaceId, modelId) {
    await rememberModelPick(sub, workspaceId, modelId);
  },
};

export interface ModelResolutionDeps {
  store: ModelStore;
  /** Absent: nothing is remembered (tests, scripts). */
  picks?: ModelPicks;
  /** `AUTH_MODE=demo` turns both in-app levels off. */
  demo: boolean;
  env: Environment;
  allowlist: BaseUrlAllowlist;
}

let defaultAllowlist: BaseUrlAllowlist | undefined;

export function defaultModelDeps(): ModelResolutionDeps {
  defaultAllowlist ??= parseBaseUrlAllowlist(config.aiBaseUrlAllowlist);
  return {
    store: pgModelStore,
    picks: pgModelPicks,
    demo: config.authMode === "demo",
    env: process.env,
    allowlist: defaultAllowlist,
  };
}

/**
 * A model ready for a generation, or why the one chosen cannot be. `id` is
 * the catalog id (a uuid, or `env:<name>` for a server model); `modelId` is
 * the vendor's model id, as the generation log and the limits count it.
 */
export type ResolvedModel =
  | { ok: true; id: string; source: ModelSource; modelId: string; model: Model }
  | { ok: false; id: string | null; source: ModelSource; problem: string };

const UNREADABLE_SETTINGS: Record<"personal" | "workspace", string> = {
  personal:
    "Your personal model configuration can no longer be read. Save it again on the Models page.",
  workspace:
    "This workspace's model configuration can no longer be read. A source-admin must save it again on the Models page.",
};

const UNREADABLE_KEY: Record<"personal" | "workspace", string> = {
  personal:
    "Your personal model key can no longer be read, because the server's SESSION_SECRET changed. Enter it again on the Models page.",
  workspace:
    "This workspace's model key can no longer be read, because the server's SESSION_SECRET changed. A source-admin must enter it again on the Models page.",
};

const MISSING_CREDENTIALS: Record<"personal" | "workspace", string> = {
  personal:
    "Your personal model has no usable credentials stored. Enter them again on the Models page.",
  workspace:
    "This workspace's model has no usable credentials stored. A source-admin must enter them again on the Models page.",
};

export function parseSettings(stored: StoredConfig): ModelSettings | null {
  const parsed = ModelSettings.safeParse({
    ...(stored.settings as object),
    provider: stored.provider,
  });
  return parsed.success ? parsed.data : null;
}

/** A stored model as a model to call, or why it cannot be one. Builds nothing that calls out. */
export function storedResolution(
  id: string,
  source: "personal" | "workspace",
  stored: StoredConfig,
  allowlist: BaseUrlAllowlist,
): ResolvedModel {
  const settings = parseSettings(stored);
  if (!settings) return { ok: false, id, source, problem: UNREADABLE_SETTINGS[source] };
  const opened = openCredentials(stored.credentials);
  if (opened.state === "unreadable") {
    return { ok: false, id, source, problem: UNREADABLE_KEY[source] };
  }
  const credentials = parseCredentials(
    kindOf(settings),
    opened.state === "ok" ? opened.credentials : {},
  );
  if (!credentials.ok) {
    return { ok: false, id, source, problem: MISSING_CREDENTIALS[source] };
  }
  return {
    ok: true,
    id,
    source,
    modelId: settings.model,
    model: configuredModel(settings, credentials.credentials, allowlist),
  };
}

/**
 * The environment's model (`AI_PROVIDER`, `AI_MODEL`, …) as the server model
 * named `default`, until `AI_MODELS_FILE` (#440).
 */
export function environmentResolution(id: string, env: Environment): ResolvedModel {
  const problem = aiConfigProblem(env);
  if (problem) {
    return {
      ok: false,
      id,
      source: "environment",
      problem: aiUnavailableMessage(problem),
    };
  }
  return {
    ok: true,
    id,
    source: "environment",
    modelId: env.AI_MODEL ?? "",
    model: getModel(env),
  };
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

/** A stored model's configuration as a page sees it: never the credentials. */
export function configView(
  stored: StoredConfig & Pick<StoredModel, "updatedBy" | "updatedAt">,
): ModelConfigView | null {
  const settings = parseSettings(stored);
  if (!settings) return null;
  return {
    settings,
    key: keyState(stored.credentials, settings),
    updatedBy: stored.updatedBy,
    updatedAt: stored.updatedAt,
  };
}

/** A catalog model as a page sees it, or null when its settings no longer parse. */
export function modelView(stored: StoredModel): ModelView | null {
  const config = configView(stored);
  if (!config) return null;
  return {
    ...config,
    id: stored.id,
    name: stored.name,
    scope: stored.scope,
    createdBy: stored.createdBy,
    createdAt: stored.createdAt,
  };
}

/** May a model be saved at all? Demo mode has the server's models only. */
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
  current: StoredConfig | null,
  deps: ModelResolutionDeps = defaultModelDeps(),
): Promise<Omit<ModelWrite, "name">> {
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

  let credentials: ModelWrite["credentials"];
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
 * A configuration and the credentials to call it with, for "Test connection"
 * and "List models": the one submitted, with the stored credentials when the
 * form left them out (same origin only, as for a save).
 */
export async function configForUse(
  input: ModelConfigInput,
  current: StoredConfig | null,
  deps: ModelResolutionDeps = defaultModelDeps(),
): Promise<{ settings: ModelSettings; credentials: Credentials }> {
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
    if (opened.state === "ok") {
      credentials = requireCredentials(kindOf(input.settings), opened.credentials);
    }
  } else if (input.credentials) {
    credentials = requireCredentials(kindOf(input.settings), input.credentials);
  }
  return { settings: input.settings, credentials };
}

/** {@link configForUse} as a model, for "Test connection". */
export async function modelForTest(
  input: ModelConfigInput,
  current: StoredConfig | null,
  deps: ModelResolutionDeps = defaultModelDeps(),
): Promise<Model> {
  const { settings, credentials } = await configForUse(input, current, deps);
  return configuredModel(settings, credentials, deps.allowlist);
}
