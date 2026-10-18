import { z } from "zod";
import {
  credentialFields,
  ModelSettings,
  PROVIDER_KINDS,
  parseCredentials,
  providerKind,
  settingsFields,
} from "@/lib/ai/providers/registry";
import { PROVIDER_LIMITS, type ProviderKind } from "@/lib/ai/providers/types";

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
 * What a configuration may be is the provider kind registry
 * (`providers/registry.ts`, #438): its `settings` are the kind's browser-safe
 * half, its credentials the sealed part. The server half (sealing, the base
 * URL guard, resolution) is `src/lib/ai/model-resolution.ts`. Nothing here,
 * and nothing any route returns, carries a credential: a view has the last
 * four characters of one at most.
 */

export { ModelSettings, type ModelProvider } from "@/lib/ai/providers/registry";
export { OPENAI_APIS, type OpenAiApi } from "@/lib/ai/providers/types";

/** Which level a generation's model came from. Recorded, never the key. */
export const MODEL_SOURCES = ["personal", "workspace", "environment"] as const;
export type ModelSource = (typeof MODEL_SOURCES)[number];

export const MODEL_CONFIG_LIMITS = PROVIDER_LIMITS;

/** At most this many credential fields in a request; no kind has more than three. */
const MAX_CREDENTIAL_FIELDS = 8;

/**
 * What a PUT carries. `credentials` is write-only: omitted, the stored ones
 * are kept (so the settings form can save a new model without them being
 * sent back to it); `null` clears them, for an endpoint that needs none; an
 * object replaces them, and is held to the kind's shape on the server.
 */
export const ModelConfigInput = z
  .object({
    settings: ModelSettings,
    credentials: z
      .record(z.string().max(64), z.string().max(PROVIDER_LIMITS.secret))
      .refine((c) => Object.keys(c).length <= MAX_CREDENTIAL_FIELDS, "too many fields")
      .nullable()
      .optional(),
  })
  .strict();
export type ModelConfigInput = z.infer<typeof ModelConfigInput>;

/** What a model is called: unique within its owner, ignoring case. */
export const ModelName = z
  .string()
  .trim()
  .min(1, "name the model")
  .max(80, "at most 80 characters");

/** A catalog model's POST and PUT body (#439): its name and configuration. */
export const ModelInput = ModelConfigInput.extend({ name: ModelName }).strict();
export type ModelInput = z.infer<typeof ModelInput>;

/** The prefix of a server model's id: `env:<name>`. */
export const SERVER_MODEL_PREFIX = "env:";

/**
 * A model id as a request may carry it: a catalog uuid, `env:<name>`, or a
 * model found on this machine, `local:<host>:<port>/<model>` (#607).
 */
export const ModelId = z
  .string()
  .max(240)
  .regex(
    /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|env:[a-z0-9][a-z0-9-]{0,39}|local:[a-z0-9.-]{1,100}:\d{1,5}\/[A-Za-z0-9._:/@+-]{1,120})$/i,
    "not a model id",
  );

/**
 * The workspace PUT (#439): which model a generation uses when nobody picks
 * (a workspace model's id, a server model's `env:<name>`, or null for the
 * server's default), and whether people may use their own models here.
 */
export const WorkspaceModelInput = z
  .object({
    defaultModel: ModelId.nullable(),
    allowPersonalKeys: z.boolean(),
  })
  .strict();
export type WorkspaceModelInput = z.infer<typeof WorkspaceModelInput>;

/** How stored credentials are shown: never the credentials. */
export type KeyState =
  | { state: "none" }
  /** `hint` is the last four characters of the first secret, or null for one too short to hint at. */
  | { state: "set"; hint: string | null }
  /** Sealed under a `SESSION_SECRET` this server no longer has: enter them again. */
  | { state: "unreadable" };

/** A stored configuration as a settings page sees it. */
export interface ModelConfigView {
  settings: ModelSettings;
  key: KeyState;
  updatedBy: string;
  updatedAt: string;
}

/** A catalog model (#439) as a page sees it: never the credentials. */
export interface ModelView extends ModelConfigView {
  id: string;
  name: string;
  scope: "workspace" | "personal";
  createdBy: string;
  createdAt: string;
}

/**
 * A workspace's models as its settings page sees them: every one, the
 * default, and the personal-keys toggle. `config` is the default when it is
 * one of the workspace's own, for the single-model card until the Models
 * page (#441).
 */
export interface WorkspaceModelView {
  workspaceId: string;
  models: ModelView[];
  defaultModel: string | null;
  config: ModelView | null;
  allowPersonalKeys: boolean;
}

/**
 * One model a caller may use in a workspace, as `GET /api/models` lists it
 * (#439): enough to pick it, never its settings beyond the model id, never
 * its credentials. `unavailable` is why it cannot be called (credentials
 * unreadable after a `SESSION_SECRET` rotation, a server variable unset), or
 * null.
 */
export interface ModelListing {
  id: string;
  name: string;
  provider: string;
  model: string;
  scope: ModelSource;
  unavailable: string | null;
}

/** `GET /api/models`: the caller's listing, and what a generation uses when nobody picks. */
export interface ModelsResponse {
  workspaceId: string;
  models: ModelListing[];
  /** The id a request without `modelId` resolves to, or null when none can. */
  defaultModel: string | null;
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

/**
 * What the settings form edits: the provider, and every field its kind
 * draws, as strings. Credentials fields start empty: stored credentials are
 * never sent back.
 */
export interface ModelConfigDraft {
  provider: string;
  settings: Record<string, string>;
  /** New values, or "" to keep the stored ones (unless `clearCredentials`). */
  credentials: Record<string, string>;
  /** Remove the stored credentials, for an endpoint that needs none. */
  clearCredentials: boolean;
}

/** An empty draft for a kind: every field blank, a select on its first option. */
export function emptyDraft(provider = "openai-compatible"): ModelConfigDraft {
  const kind =
    providerKind(provider) ??
    (PROVIDER_KINDS["openai-compatible"] as unknown as ProviderKind);
  return {
    provider: kind.kind,
    settings: Object.fromEntries(
      settingsFields(kind).map((f) => [f.name, f.options?.[0]?.value ?? ""]),
    ),
    credentials: Object.fromEntries(credentialFields(kind).map((f) => [f.name, ""])),
    clearCredentials: false,
  };
}

export const EMPTY_MODEL_DRAFT: ModelConfigDraft = emptyDraft();

export function draftFromView(view: ModelConfigView | null): ModelConfigDraft {
  if (!view) return emptyDraft();
  const draft = emptyDraft(view.settings.provider);
  const stored = view.settings as Record<string, unknown>;
  for (const name of Object.keys(draft.settings)) {
    const value = stored[name];
    if (typeof value === "string") draft.settings[name] = value;
  }
  return draft;
}

/**
 * The PUT body for a draft, or the first problem with it. Blank credentials
 * fields leave `credentials` out, which keeps the stored ones; "clear" sends
 * null. A kind with several credentials fields takes them all at once: one
 * half of a key pair cannot be kept beside a new other half.
 */
export function inputFromDraft(
  draft: ModelConfigDraft,
): { ok: true; input: ModelConfigInput } | { ok: false; message: string } {
  const kind = providerKind(draft.provider);
  if (!kind) return { ok: false, message: "Provider: choose one" };

  const settings: Record<string, string> = { provider: kind.kind };
  for (const field of settingsFields(kind)) {
    const value = (draft.settings[field.name] ?? "").trim();
    if (value !== "" || !field.optional) settings[field.name] = value;
  }
  const parsedSettings = kind.settings.safeParse(settings);
  if (!parsedSettings.success) {
    const issue = parsedSettings.error.issues[0];
    const field = kind.fields.find((f) => f.name === issue.path[0]);
    return { ok: false, message: `${field?.label ?? "Settings"}: ${issue.message}` };
  }

  let credentials: ModelConfigInput["credentials"];
  if (draft.clearCredentials) {
    credentials = null;
  } else {
    const entered = Object.fromEntries(
      credentialFields(kind)
        .map((f) => [f.name, (draft.credentials[f.name] ?? "").trim()] as const)
        .filter(([, value]) => value !== ""),
    );
    if (Object.keys(entered).length > 0) {
      const checked = parseCredentials(kind, entered);
      if (!checked.ok) return { ok: false, message: checked.message };
      credentials = checked.credentials;
    }
  }

  const parsed = ModelConfigInput.safeParse({
    settings: parsedSettings.data,
    ...(credentials === undefined ? {} : { credentials }),
  });
  if (parsed.success) return { ok: true, input: parsed.data };
  return { ok: false, message: parsed.error.issues[0].message };
}

/** What the credentials of a kind are called in a sentence: "key" for one field. */
export function credentialsNoun(kind: ProviderKind | null): string {
  return kind && credentialFields(kind).length > 1 ? "credentials" : "key";
}

/** How stored credentials are described next to their fields. */
export function describeKey(key: KeyState | undefined, noun = "key"): string {
  const plural = noun === "credentials";
  if (!key || key.state === "none") return `No ${noun} stored.`;
  if (key.state === "unreadable") {
    return `The stored ${noun} can no longer be read (the server's SESSION_SECRET changed). Enter ${plural ? "them" : "it"} again.`;
  }
  if (plural) {
    return key.hint
      ? `Credentials are stored (ending in ${key.hint}).`
      : "Credentials are stored.";
  }
  return key.hint ? `A key ending in ${key.hint} is stored.` : "A key is stored.";
}

/* -------------------------------------------------------------------------- */
/* The Models page (#441)                                                     */
/* -------------------------------------------------------------------------- */

/** A server model as the Models page shows it: read-only, with where its credentials come from. */
export interface ServerModelRow {
  id: string;
  name: string;
  provider: string;
  model: string;
  /** The variables its credentials come from, by field; never their values. */
  credentialVars: Record<string, string>;
  unavailable: string | null;
  isDefault: boolean;
}

/**
 * A workspace or personal model as the Models page lists it. `view` (its
 * settings and the credentials' state) is present only for someone who may
 * edit it: a workspace's source-admins, or the model's owner.
 */
export interface CatalogModelRow {
  id: string;
  name: string;
  provider: string;
  model: string;
  unavailable: string | null;
  view: ModelView | null;
}

export interface WorkspaceModelsSection {
  workspaceId: string;
  /** Holds `source:manage` here: may add, edit, test, delete and set the default. */
  canManage: boolean;
  /** What a generation here uses when nobody picks, as stored: a model id, or null for the server's default. */
  defaultModel: string | null;
  allowPersonalKeys: boolean;
  models: CatalogModelRow[];
}

/** One endpoint at the last scan for a model on this machine (#607): its host, never a reply. */
export interface DetectedEndpointRow {
  host: string;
  ok: boolean;
  models: number;
}

/** "Detected on this machine" (#607): what the last scan found, and whether to say how to get one. */
export interface DetectedModelsSection {
  /** When the last scan finished, ISO 8601, or null before the first. */
  scannedAt: string | null;
  endpoints: DetectedEndpointRow[];
  rows: ServerModelRow[];
  /** Models were found but none is the default: the person picks one. */
  pickNeeded: boolean;
  /** The server runs in local mode, so the page says how to start a model here. */
  local: boolean;
  /** A workspace the caller manages, which a Re-scan is gated on; null hides the button. */
  rescanWorkspace: string | null;
}

/** Everything the Models page draws, read on the server. */
export interface ModelsPageData {
  server: ServerModelRow[];
  /** Models found on this machine (#607), or null when detection is off. */
  detected: DetectedModelsSection | null;
  workspaces: WorkspaceModelsSection[];
  /** The caller's own models, or null where they may have none (demo mode). */
  personal: CatalogModelRow[] | null;
  /** The workspaces that allow personal models, among those the caller generates in. */
  personalAppliesIn: string[];
  demo: boolean;
  allowStub: boolean;
}

/** One model a vendor lists (#443): the id to configure, and its display name. */
export interface DiscoveredModel {
  id: string;
  name?: string;
}
