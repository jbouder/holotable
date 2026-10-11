import type { JSONValue, LanguageModel } from "ai";
import type { z } from "zod";
import type { Credentials } from "@/lib/ai/providers/registry";
import type { ProviderKind } from "@/lib/ai/providers/types";

/** A model as an SDK builds it, before the deadline and retry wrap it. */
export type BaseModel = Extract<LanguageModel, { specificationVersion: "v4" }>;

/** Options keyed by the SDK's provider name, as `providerOptions` takes them. */
export type ProviderOptions = Record<string, Record<string, JSONValue>>;

/**
 * A provider kind's server half (#438): how a model of this kind is built.
 * `build` is handed everything it may use: the parsed settings, the opened
 * credentials and the `fetch` every request goes through (the base URL guard
 * for a typed endpoint, the vendor's origin otherwise). It must pass the
 * credentials and the vendor's URL to the SDK explicitly, so the SDK never
 * falls back to the server's own environment (`ANTHROPIC_API_KEY`,
 * `AWS_BEARER_TOKEN_BEDROCK`, `OPENAI_BASE_URL` …): a workspace's model must
 * never be able to spend the operator's key.
 */
export interface ServerProviderKind<Kind extends ProviderKind = ProviderKind> {
  kind: Kind["kind"];
  /** What `modelSettings()` spreads for this kind, keyed by the SDK's provider name. */
  providerOptions: ProviderOptions;
  build(
    settings: z.infer<Kind["settings"]>,
    credentials: Credentials,
    fetch: typeof globalThis.fetch,
  ): BaseModel;
}

export function defineServerKind<Kind extends ProviderKind>(
  _kind: Kind,
  server: ServerProviderKind<Kind>,
): ServerProviderKind<Kind> {
  return server;
}
