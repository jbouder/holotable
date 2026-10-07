import { z } from "zod";

/**
 * In-app model configuration (#331), the browser-safe half: what a workspace
 * or a person may configure, and what the settings pages are shown of it.
 *
 * A configuration is resolved per generation request, first match wins:
 *
 *   1. the caller's **personal** configuration, when they have one AND the
 *      workspace allows personal keys;
 *   2. the **workspace** configuration, when one is set;
 *   3. the **environment** (`AI_PROVIDER`, `AI_MODEL`, …), unchanged.
 *
 * The server half (sealing the key, the base-URL guard, resolution) is
 * `src/lib/ai/model-resolution.ts`. Nothing here, and nothing any route
 * returns, carries an API key: a view has the key's last four characters at
 * most.
 */

/** Which level a generation's model came from. Recorded, never the key. */
export const MODEL_SOURCES = ["personal", "workspace", "environment"] as const;
export type ModelSource = (typeof MODEL_SOURCES)[number];

/** Two OpenAI-compatible surfaces, the same switch as `OPENAI_API`. */
export const OPENAI_APIS = ["responses", "chat"] as const;
export type OpenAiApi = (typeof OPENAI_APIS)[number];

export const MODEL_CONFIG_LIMITS = {
  baseUrl: 2_048,
  model: 200,
  apiKey: 4_096,
} as const;

/**
 * The provider's own settings, keyed by `provider`. A discriminated union so
 * a native provider (Anthropic, Gemini, Azure, Bedrock) is a new member here
 * and not a migration: the row stores `provider` and these settings as JSON.
 */
export const ModelSettings = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("openai-compatible"),
      baseUrl: z
        .url({ protocol: /^https?$/, error: "must be an http(s) URL" })
        .max(MODEL_CONFIG_LIMITS.baseUrl),
      model: z.string().trim().min(1, "name a model").max(MODEL_CONFIG_LIMITS.model),
      api: z.enum(OPENAI_APIS).default("responses"),
    })
    .strict(),
]);
export type ModelSettings = z.infer<typeof ModelSettings>;
export type ModelProvider = ModelSettings["provider"];

/**
 * What a PUT carries. `apiKey` is write-only: omitted, the stored key is kept
 * (so the settings form can save a new model without the key being sent back
 * to it); an empty string clears it, for an endpoint that needs none.
 */
export const ModelConfigInput = z
  .object({
    settings: ModelSettings,
    apiKey: z.string().max(MODEL_CONFIG_LIMITS.apiKey).optional(),
  })
  .strict();
export type ModelConfigInput = z.infer<typeof ModelConfigInput>;

/** The workspace PUT: its configuration (or null to use the environment) and the toggle. */
export const WorkspaceModelInput = z
  .object({
    config: ModelConfigInput.nullable(),
    allowPersonalKeys: z.boolean(),
  })
  .strict();
export type WorkspaceModelInput = z.infer<typeof WorkspaceModelInput>;

/** How a stored key is shown: never the key. */
export type KeyState =
  | { state: "none" }
  /** `hint` is the last four characters, or null for a key too short to hint at. */
  | { state: "set"; hint: string | null }
  /** Sealed under a `SESSION_SECRET` this server no longer has: enter it again. */
  | { state: "unreadable" };

/** A stored configuration as a settings page sees it. */
export interface ModelConfigView {
  settings: ModelSettings;
  key: KeyState;
  updatedBy: string;
  updatedAt: string;
}

export interface WorkspaceModelView {
  workspaceId: string;
  /** Null when the workspace uses the environment's model. */
  config: ModelConfigView | null;
  allowPersonalKeys: boolean;
}

/**
 * Which model a generation by this caller in this workspace will use, as the
 * settings pages and the prompt boxes show it. `unavailable` is the reason
 * generation cannot be attempted, or null.
 */
export interface EffectiveModel {
  source: ModelSource;
  /** The model id, or "" when none is configured. */
  model: string;
  unavailable: string | null;
}

/** Shortest key that gets a last-four hint; shorter, four characters is too much of it. */
export const MIN_HINTED_KEY = 16;

/** The last four characters of a key long enough to show them, or null. */
export function keyHint(key: string): string | null {
  return key.length >= MIN_HINTED_KEY ? key.slice(-4) : null;
}

export const MODEL_SOURCE_LABELS: Record<ModelSource, string> = {
  personal: "Your personal model",
  workspace: "Workspace model",
  environment: "Server default",
};

/** What the settings form edits. The key field starts empty: a stored key is never sent back. */
export interface ModelConfigDraft {
  baseUrl: string;
  model: string;
  api: OpenAiApi;
  /** A new key, or "" to keep the stored one (unless `clearKey`). */
  apiKey: string;
  /** Remove the stored key, for an endpoint that needs none. */
  clearKey: boolean;
}

export const EMPTY_MODEL_DRAFT: ModelConfigDraft = {
  baseUrl: "",
  model: "",
  api: "responses",
  apiKey: "",
  clearKey: false,
};

export function draftFromView(view: ModelConfigView | null): ModelConfigDraft {
  if (!view) return EMPTY_MODEL_DRAFT;
  return {
    ...EMPTY_MODEL_DRAFT,
    baseUrl: view.settings.baseUrl,
    model: view.settings.model,
    api: view.settings.api,
  };
}

/**
 * The PUT body for a draft, or the first problem with it. A blank key field
 * leaves `apiKey` out, which keeps the stored key; "clear" sends an empty one.
 */
export function inputFromDraft(
  draft: ModelConfigDraft,
): { ok: true; input: ModelConfigInput } | { ok: false; message: string } {
  const apiKey = draft.clearKey ? "" : draft.apiKey.trim() || undefined;
  const parsed = ModelConfigInput.safeParse({
    settings: {
      provider: "openai-compatible",
      baseUrl: draft.baseUrl.trim(),
      model: draft.model.trim(),
      api: draft.api,
    },
    ...(apiKey === undefined ? {} : { apiKey }),
  });
  if (parsed.success) return { ok: true, input: parsed.data };
  const issue = parsed.error.issues[0];
  const field = issue.path.at(-1);
  const name = field === "baseUrl" ? "Base URL" : field === "model" ? "Model" : "API key";
  return { ok: false, message: `${name}: ${issue.message}` };
}

/** How a stored key is described next to the key field. */
export function describeKey(key: KeyState | undefined): string {
  if (!key || key.state === "none") return "No key stored.";
  if (key.state === "unreadable") {
    return "The stored key can no longer be read (the server's SESSION_SECRET changed). Enter it again.";
  }
  return key.hint ? `A key ending in ${key.hint} is stored.` : "A key is stored.";
}
