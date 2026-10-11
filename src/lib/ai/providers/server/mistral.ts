import { createMistral } from "@ai-sdk/mistral";
import { MISTRAL_ORIGIN, mistralKind } from "@/lib/ai/providers/kinds/mistral";
import { defineServerKind } from "@/lib/ai/providers/server/types";

export const mistralServer = defineServerKind(mistralKind, {
  kind: "mistral",
  providerOptions: {},
  build(settings, credentials, fetch) {
    return createMistral({
      baseURL: `${MISTRAL_ORIGIN}/v1`,
      apiKey: credentials.apiKey,
      fetch,
    })(settings.model);
  },
});
