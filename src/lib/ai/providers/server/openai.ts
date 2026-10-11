import { createOpenAI } from "@ai-sdk/openai";
import { OPENAI_ORIGIN, openaiKind } from "@/lib/ai/providers/kinds/openai";
import { OPENAI_PROVIDER_OPTIONS } from "@/lib/ai/providers/server/openai-compatible";
import { defineServerKind } from "@/lib/ai/providers/server/types";

export const openaiServer = defineServerKind(openaiKind, {
  kind: "openai",
  providerOptions: OPENAI_PROVIDER_OPTIONS,
  build(settings, credentials, fetch) {
    return createOpenAI({
      // Spelled out, so an operator's OPENAI_BASE_URL never moves it.
      baseURL: `${OPENAI_ORIGIN}/v1`,
      apiKey: credentials.apiKey,
      fetch,
    })(settings.model);
  },
});
