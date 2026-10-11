import type { BaseUrlAllowlist } from "@/lib/ai/base-url";
import { guardedFetch, pinnedFetch, refusingFetch } from "@/lib/ai/guarded-fetch";
import {
  type Credentials,
  endpointOf,
  kindOf,
  type ModelSettings,
  type ProviderKindName,
} from "@/lib/ai/providers/registry";
import { anthropicServer } from "@/lib/ai/providers/server/anthropic";
import { azureServer } from "@/lib/ai/providers/server/azure";
import { bedrockServer } from "@/lib/ai/providers/server/bedrock";
import { gatewayServer } from "@/lib/ai/providers/server/gateway";
import { googleServer } from "@/lib/ai/providers/server/google";
import { mistralServer } from "@/lib/ai/providers/server/mistral";
import { openaiServer } from "@/lib/ai/providers/server/openai";
import { openaiCompatibleServer } from "@/lib/ai/providers/server/openai-compatible";
import { stubServer } from "@/lib/ai/providers/server/stub";
import type {
  BaseModel,
  ProviderOptions,
  ServerProviderKind,
} from "@/lib/ai/providers/server/types";
import { xaiServer } from "@/lib/ai/providers/server/xai";

/**
 * The provider kinds' server halves (#438), one per kind in
 * `../registry.ts`. The `satisfies` makes a kind without a server half a
 * compile error.
 */
export const SERVER_PROVIDER_KINDS = {
  "openai-compatible": openaiCompatibleServer,
  openai: openaiServer,
  anthropic: anthropicServer,
  google: googleServer,
  gateway: gatewayServer,
  azure: azureServer,
  bedrock: bedrockServer,
  mistral: mistralServer,
  xai: xaiServer,
  stub: stubServer,
} satisfies Record<ProviderKindName, { kind: string }>;

export function serverProviderKind(settings: ModelSettings): ServerProviderKind {
  return SERVER_PROVIDER_KINDS[settings.provider] as unknown as ServerProviderKind;
}

/**
 * The `fetch` a configuration's requests go through: the base URL guard,
 * DNS included, for an endpoint a person typed; the vendor's own origin
 * otherwise; nothing at all for a kind that makes no requests.
 */
export function fetchFor(
  settings: ModelSettings,
  allowlist: BaseUrlAllowlist,
): typeof globalThis.fetch {
  const endpoint = endpointOf(settings);
  if (endpoint === null) return refusingFetch;
  return kindOf(settings).userSetsEndpoint
    ? guardedFetch(endpoint, allowlist)
    : pinnedFetch(new URL(endpoint).origin);
}

/** A configured model, unwrapped, with the kind's SDK and the fetch above. */
export function buildModel(
  settings: ModelSettings,
  credentials: Credentials,
  allowlist: BaseUrlAllowlist,
  fetch: typeof globalThis.fetch = fetchFor(settings, allowlist),
): BaseModel {
  return serverProviderKind(settings).build(settings, credentials, fetch);
}

/** What `modelSettings()` spreads for a model of this configuration's kind. */
export function providerOptionsFor(settings: ModelSettings): ProviderOptions {
  return serverProviderKind(settings).providerOptions;
}
