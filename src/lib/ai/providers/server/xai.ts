import { listOpenAiStyle } from "@/lib/ai/providers/server/list";
import { createXai } from "@ai-sdk/xai";
import { XAI_ORIGIN, xaiKind } from "@/lib/ai/providers/kinds/xai";
import { defineServerKind } from "@/lib/ai/providers/server/types";

export const xaiServer = defineServerKind(xaiKind, {
  kind: "xai",
  providerOptions: {},
  build(settings, credentials, fetch) {
    return createXai({
      baseURL: `${XAI_ORIGIN}/v1`,
      apiKey: credentials.apiKey,
      fetch,
    })(settings.model);
  },
  listModels: (_settings, credentials, fetch) =>
    listOpenAiStyle(fetch, `${XAI_ORIGIN}/v1`, credentials.apiKey),
});
