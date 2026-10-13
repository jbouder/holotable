import { z } from "zod";
import { anthropicKind } from "@/lib/ai/providers/kinds/anthropic";
import { anthropicCompatibleKind } from "@/lib/ai/providers/kinds/anthropic-compatible";
import { azureKind } from "@/lib/ai/providers/kinds/azure";
import { bedrockKind } from "@/lib/ai/providers/kinds/bedrock";
import { gatewayKind } from "@/lib/ai/providers/kinds/gateway";
import { googleKind } from "@/lib/ai/providers/kinds/google";
import { mistralKind } from "@/lib/ai/providers/kinds/mistral";
import { openaiKind } from "@/lib/ai/providers/kinds/openai";
import { openaiCompatibleKind } from "@/lib/ai/providers/kinds/openai-compatible";
import { stubKind } from "@/lib/ai/providers/kinds/stub";
import { xaiKind } from "@/lib/ai/providers/kinds/xai";
import type { ProviderField, ProviderKind } from "@/lib/ai/providers/types";

/**
 * The provider kinds (#438), the browser-safe half: what a model may be
 * configured against, declared once per kind. The server half, which builds
 * the model with the kind's SDK, is `server/registry.ts`.
 *
 * A new vendor is a module under `kinds/` and one under `server/`, and an
 * entry in both registries. Nothing outside `src/lib/ai/providers/` compares
 * a provider's name or imports an `@ai-sdk/*` package;
 * `test/provider-kinds.test.ts` holds that.
 */
export const PROVIDER_KINDS = {
  "openai-compatible": openaiCompatibleKind,
  openai: openaiKind,
  anthropic: anthropicKind,
  "anthropic-compatible": anthropicCompatibleKind,
  google: googleKind,
  gateway: gatewayKind,
  azure: azureKind,
  bedrock: bedrockKind,
  mistral: mistralKind,
  xai: xaiKind,
  stub: stubKind,
} as const;

export type ProviderKindName = keyof typeof PROVIDER_KINDS;

export const PROVIDER_KIND_NAMES = Object.keys(PROVIDER_KINDS) as ProviderKindName[];

/**
 * A model's browser-safe configuration, keyed by `provider`: each stored row
 * parses against its own kind's schema.
 */
export const ModelSettings = z.discriminatedUnion("provider", [
  openaiCompatibleKind.settings,
  openaiKind.settings,
  anthropicKind.settings,
  anthropicCompatibleKind.settings,
  googleKind.settings,
  gatewayKind.settings,
  azureKind.settings,
  bedrockKind.settings,
  mistralKind.settings,
  xaiKind.settings,
  stubKind.settings,
]);
export type ModelSettings = z.infer<typeof ModelSettings>;
export type ModelProvider = ModelSettings["provider"];

/** A kind by name, or null for a name the registry does not have. */
export function providerKind(name: string): ProviderKind | null {
  return Object.hasOwn(PROVIDER_KINDS, name)
    ? (PROVIDER_KINDS[name as ProviderKindName] as unknown as ProviderKind)
    : null;
}

/** The kind a parsed configuration belongs to. */
export function kindOf(settings: ModelSettings): ProviderKind {
  return PROVIDER_KINDS[settings.provider] as unknown as ProviderKind;
}

/** The origin a configuration's requests go to, or null for none (the stub). */
export function endpointOf(settings: ModelSettings): string | null {
  return kindOf(settings).endpoint(settings);
}

/** The kinds the provider select offers; the stub only outside production. */
export function selectableKinds(production: boolean): ProviderKind[] {
  return PROVIDER_KIND_NAMES.map((name) => providerKind(name) as ProviderKind).filter(
    (kind) => !(production && kind.developmentOnly),
  );
}

/** The fields that belong to the sealed credentials, in form order. */
export function credentialFields(kind: ProviderKind): ProviderField[] {
  return kind.fields.filter((field) => field.in === "credentials");
}

/** The fields that belong to the browser-safe settings, in form order. */
export function settingsFields(kind: ProviderKind): ProviderField[] {
  return kind.fields.filter((field) => field.in === "settings");
}

/** Credentials as their kind declares them: string values, keyed by field name. */
export type Credentials = Record<string, string>;

/**
 * Credentials held to their kind's shape, or the first problem in words that
 * name the field and never its value.
 */
export function parseCredentials(
  kind: ProviderKind,
  raw: unknown,
): { ok: true; credentials: Credentials } | { ok: false; message: string } {
  const parsed = kind.credentials.safeParse(raw);
  if (parsed.success) {
    // Empty optional values are dropped, so `{ apiKey: "" }` is no key.
    const credentials = Object.fromEntries(
      Object.entries(parsed.data as Record<string, unknown>).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" && entry[1] !== "",
      ),
    );
    return { ok: true, credentials };
  }
  const issue = parsed.error.issues[0];
  const name = String(issue.path[0] ?? "");
  const field = kind.fields.find((f) => f.name === name);
  if (issue.code === "unrecognized_keys") {
    return { ok: false, message: `${kind.label} takes no ${issue.keys.join(", ")}.` };
  }
  return {
    ok: false,
    message: `${field?.label ?? (name || "Credentials")}: ${issue.message}`,
  };
}

/** The origin of a configuration's requests, or null for a kind that makes none. */
export function originOf(settings: ModelSettings): string | null {
  const endpoint = endpointOf(settings);
  return endpoint === null ? null : new URL(endpoint).origin;
}

/** The host requests go to, for an audit row: never a path, never a credential. */
export function endpointHost(settings: ModelSettings): string | null {
  const endpoint = endpointOf(settings);
  return endpoint === null ? null : new URL(endpoint).host;
}
