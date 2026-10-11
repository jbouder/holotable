import { cappedFetch, toDiscovered } from "@/lib/ai/providers/server/list";
import { createGateway } from "ai";
import { GATEWAY_ORIGIN, gatewayKind } from "@/lib/ai/providers/kinds/gateway";
import { defineServerKind } from "@/lib/ai/providers/server/types";

export const gatewayServer = defineServerKind(gatewayKind, {
  kind: "gateway",
  providerOptions: {},
  build(settings, credentials, fetch) {
    // The key is always passed, so neither AI_GATEWAY_API_KEY nor a Vercel
    // OIDC token from the environment is ever used for a stored model.
    return createGateway({
      baseURL: `${GATEWAY_ORIGIN}/v4/ai`,
      apiKey: credentials.apiKey,
      fetch,
    })(settings.model);
  },
  async listModels(_settings, credentials, fetch) {
    const gateway = createGateway({
      baseURL: `${GATEWAY_ORIGIN}/v4/ai`,
      apiKey: credentials.apiKey,
      fetch: cappedFetch(fetch),
    });
    const { models } = await gateway.getAvailableModels();
    // Language models only: the gateway also lists embedding and image models.
    return toDiscovered(models, (e) =>
      e.modelType == null || e.modelType === "language"
        ? { id: e.id, name: e.name }
        : null,
    );
  },
});
