import { fetchModelList, toDiscovered } from "@/lib/ai/providers/server/list";
import { createAnthropic } from "@ai-sdk/anthropic";
import { ANTHROPIC_ORIGIN, anthropicKind } from "@/lib/ai/providers/kinds/anthropic";
import { defineServerKind } from "@/lib/ai/providers/server/types";

export const anthropicServer = defineServerKind(anthropicKind, {
  kind: "anthropic",
  providerOptions: {},
  build(settings, credentials, fetch) {
    return createAnthropic({
      baseURL: `${ANTHROPIC_ORIGIN}/v1`,
      apiKey: credentials.apiKey,
      fetch,
    })(settings.model);
  },
  async listModels(_settings, credentials, fetch) {
    const json = await fetchModelList(fetch, `${ANTHROPIC_ORIGIN}/v1/models?limit=1000`, {
      "x-api-key": credentials.apiKey ?? "",
      "anthropic-version": "2023-06-01",
    });
    return toDiscovered((json as { data?: unknown })?.data, (e) => ({
      id: e.id,
      name: e.display_name,
    }));
  },
});
