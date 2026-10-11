import { createOpenAI } from "@ai-sdk/openai";
import { openaiCompatibleKind } from "@/lib/ai/providers/kinds/openai-compatible";
import { defineServerKind } from "@/lib/ai/providers/server/types";

/**
 * Strict structured outputs accept a schema only when every property is
 * required, and refuse the IR, whose optional fields are the point (#336).
 * Non-strict, the schema is still sent and followed; what comes back is
 * validated against the IR either way. Shared by every kind on the OpenAI
 * protocol.
 */
export const OPENAI_PROVIDER_OPTIONS = { openai: { strictJsonSchema: false } };

export const openaiCompatibleServer = defineServerKind(openaiCompatibleKind, {
  kind: "openai-compatible",
  providerOptions: OPENAI_PROVIDER_OPTIONS,
  build(settings, credentials, fetch) {
    // The key is always a string, so `OPENAI_API_KEY` is never read; an
    // endpoint that needs none gets an empty one.
    const openai = createOpenAI({
      baseURL: settings.baseUrl,
      apiKey: credentials.apiKey ?? "",
      fetch,
    });
    return settings.api === "chat" ? openai.chat(settings.model) : openai(settings.model);
  },
});
