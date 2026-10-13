import { z } from "zod";

/**
 * What a provider kind is (#437, #438), the browser-safe half. A kind is one
 * module under `kinds/`; its server half, which builds the model with the
 * kind's SDK, is the module of the same name under `server/`. The panel
 * (#61) and source (#382) registries are built the same way: a kind is
 * declared once, and nothing outside `src/lib/ai/providers/` decides by
 * comparing a provider's name.
 */

export const PROVIDER_LIMITS = {
  /** A typed endpoint (an OpenAI-compatible base URL). */
  baseUrl: 2_048,
  /** A model id, deployment name, region or resource name. */
  model: 200,
  /** One secret value: an API key, or one half of a key pair. */
  secret: 4_096,
} as const;

/**
 * A base URL a person types, for a kind whose endpoint is theirs to choose
 * (`openai-compatible`, `anthropic-compatible`). The kind sets
 * `userSetsEndpoint`, so the base URL guard holds it on save and on every
 * connection.
 */
export const baseUrlField = () =>
  z
    .url({ protocol: /^https?$/, error: "must be an http(s) URL" })
    .max(PROVIDER_LIMITS.baseUrl);

export const baseUrlInput = (placeholder: string): ProviderField => ({
  name: "baseUrl",
  in: "settings",
  label: "Base URL",
  placeholder,
  input: "url",
  maxLength: PROVIDER_LIMITS.baseUrl,
});

/** An API key that may be left empty, for an endpoint that needs none. */
export const OptionalApiKeyCredentials = z
  .object({ apiKey: z.string().trim().max(PROVIDER_LIMITS.secret).optional() })
  .strict();

export const optionalApiKeyField = (placeholder: string): ProviderField => ({
  name: "apiKey",
  in: "credentials",
  label: "API key",
  placeholder,
  secret: true,
  optional: true,
  maxLength: PROVIDER_LIMITS.secret,
});

/** The model id every kind's settings carry. */
export const modelField = (message = "name a model") =>
  z.string().trim().min(1, message).max(PROVIDER_LIMITS.model);

/** One secret value, required. */
export const secretField = (message = "enter the API key") =>
  z.string().trim().min(1, message).max(PROVIDER_LIMITS.secret);

/** Two OpenAI-protocol surfaces, the same switch as `OPENAI_API`. */
export const OPENAI_APIS = ["responses", "chat"] as const;
export type OpenAiApi = (typeof OPENAI_APIS)[number];

export const API_FIELD_OPTIONS: readonly ProviderFieldOption[] = [
  { value: "responses", label: "Responses API (/responses)" },
  { value: "chat", label: "Chat Completions (/chat/completions)" },
];

export interface ProviderFieldOption {
  value: string;
  label: string;
}

/**
 * One input the configuration form draws, in order. `in` says which half of
 * the configuration it fills: the browser-safe `settings`, or the sealed
 * `credentials`. A credentials field is always write-only: the form starts
 * it empty whatever is stored.
 */
export interface ProviderField {
  name: string;
  in: "settings" | "credentials";
  label: string;
  placeholder?: string;
  /** A short line under the field. */
  help?: string;
  /** Drawn as a password field and never sent back. Every credentials field is. */
  secret?: boolean;
  /** May be left empty. */
  optional?: boolean;
  input?: "text" | "url" | "select";
  /** For `input: "select"`; the first is the default. */
  options?: readonly ProviderFieldOption[];
  maxLength: number;
}

/**
 * A provider kind's browser-safe declaration. `Settings` always carries
 * `provider` (the discriminant) and `model`.
 */
export interface ProviderKind<
  Name extends string = string,
  Settings extends z.ZodObject = z.ZodObject,
  Credentials extends z.ZodObject = z.ZodObject,
> {
  kind: Name;
  /** The name on the provider select. */
  label: string;
  /** One line under the select: what the kind talks to. */
  description: string;
  docsUrl: string;
  /** Validated as a stored or submitted configuration; `.strict()`. */
  settings: Settings;
  /** The shape of the sealed part. */
  credentials: Credentials;
  fields: readonly ProviderField[];
  /**
   * Where every request goes, or null for a kind that makes none (the stub):
   * the typed base URL for a kind whose endpoint a person sets (its origin
   * is what requests are held to, the whole URL what the guard checks), the
   * vendor's origin otherwise, derived from the settings where the vendor's
   * host names the resource or region.
   */
  endpoint(settings: z.infer<Settings>): string | null;
  /** Whether a person types the endpoint, so the base URL guard applies to it. */
  userSetsEndpoint: boolean;
  /** Listed on the provider select only outside production (the stub). */
  developmentOnly?: boolean;
  /** The vendor can list its models, so the form offers "List models" (#443). */
  listsModels?: boolean;
}

/** Identity function that keeps a kind's literal types. */
export function defineProviderKind<
  Name extends string,
  Settings extends z.ZodObject,
  Credentials extends z.ZodObject,
>(
  kind: ProviderKind<Name, Settings, Credentials>,
): ProviderKind<Name, Settings, Credentials> {
  return kind;
}

/** The one-field `{ apiKey }` credentials most vendors use, and its form field. */
export const ApiKeyCredentials = z.object({ apiKey: secretField() }).strict();

export const apiKeyField = (placeholder: string): ProviderField => ({
  name: "apiKey",
  in: "credentials",
  label: "API key",
  placeholder,
  secret: true,
  maxLength: PROVIDER_LIMITS.secret,
});

export const modelInput = (placeholder: string, label = "Model"): ProviderField => ({
  name: "model",
  in: "settings",
  label,
  placeholder,
  maxLength: PROVIDER_LIMITS.model,
});
