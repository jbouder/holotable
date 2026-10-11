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
});
