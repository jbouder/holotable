import { fetchModelList, toDiscovered } from "@/lib/ai/providers/server/list";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { GOOGLE_ORIGIN, googleKind } from "@/lib/ai/providers/kinds/google";
import { defineServerKind } from "@/lib/ai/providers/server/types";

export const googleServer = defineServerKind(googleKind, {
  kind: "google",
  providerOptions: {},
  build(settings, credentials, fetch) {
    return createGoogleGenerativeAI({
      baseURL: `${GOOGLE_ORIGIN}/v1beta`,
      apiKey: credentials.apiKey,
      fetch,
    })(settings.model);
  },
  async listModels(_settings, credentials, fetch) {
    const json = await fetchModelList(
      fetch,
      `${GOOGLE_ORIGIN}/v1beta/models?pageSize=1000`,
      {
        "x-goog-api-key": credentials.apiKey ?? "",
      },
    );
    // Only models that generate text, by their bare id (`models/x` is `x`).
    return toDiscovered((json as { models?: unknown })?.models, (e) =>
      Array.isArray(e.supportedGenerationMethods) &&
      e.supportedGenerationMethods.includes("generateContent") &&
      typeof e.name === "string"
        ? { id: e.name.replace(/^models\//, ""), name: e.displayName }
        : null,
    );
  },
});
