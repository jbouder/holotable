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
});
