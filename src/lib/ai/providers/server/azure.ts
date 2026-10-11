import { createAzure } from "@ai-sdk/azure";
import { azureKind } from "@/lib/ai/providers/kinds/azure";
import { OPENAI_PROVIDER_OPTIONS } from "@/lib/ai/providers/server/openai-compatible";
import { defineServerKind } from "@/lib/ai/providers/server/types";

export const azureServer = defineServerKind(azureKind, {
  kind: "azure",
  // Azure's models are OpenAI's, behind the same strict-schema default (#336).
  providerOptions: { ...OPENAI_PROVIDER_OPTIONS, azure: { strictJsonSchema: false } },
  build(settings, credentials, fetch) {
    const azure = createAzure({
      resourceName: settings.resourceName,
      apiKey: credentials.apiKey,
      fetch,
      ...(settings.apiVersion
        ? { apiVersion: settings.apiVersion, useDeploymentBasedUrls: true }
        : {}),
    });
    return settings.api === "chat" ? azure.chat(settings.model) : azure(settings.model);
  },
});
