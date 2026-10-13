import { fetchModelList, toDiscovered } from "@/lib/ai/providers/server/list";
import { createAnthropic } from "@ai-sdk/anthropic";
import { anthropicCompatibleKind } from "@/lib/ai/providers/kinds/anthropic-compatible";
import { defineServerKind } from "@/lib/ai/providers/server/types";

export const anthropicCompatibleServer = defineServerKind(anthropicCompatibleKind, {
  kind: "anthropic-compatible",
  providerOptions: {},
  build(settings, credentials, fetch) {
    // The SDK posts to `<baseURL>/messages`. The key is always a string, so
    // `ANTHROPIC_API_KEY` is never read; an endpoint that needs none gets an
    // empty one.
    return createAnthropic({
      baseURL: settings.baseUrl.replace(/\/+$/, ""),
      apiKey: credentials.apiKey ?? "",
      fetch,
    })(settings.model);
  },
  async listModels(settings, credentials, fetch) {
    // Anthropic's own `/models` reads `x-api-key`; an aggregator's often
    // reads a bearer token. Both carry the same key, to the same origin.
    const key = credentials.apiKey;
    const json = await fetchModelList(
      fetch,
      `${settings.baseUrl.replace(/\/+$/, "")}/models`,
      {
        "anthropic-version": "2023-06-01",
        ...(key ? { "x-api-key": key, authorization: `Bearer ${key}` } : {}),
      },
    );
    return toDiscovered((json as { data?: unknown })?.data, (e) => ({
      id: e.id,
      name: e.display_name ?? e.name,
    }));
  },
});
