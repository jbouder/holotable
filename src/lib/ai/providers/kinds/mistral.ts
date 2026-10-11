import { fixedApiKeyKind } from "@/lib/ai/providers/kinds/fixed";

export const MISTRAL_ORIGIN = "https://api.mistral.ai";

export const mistralKind = fixedApiKeyKind({
  kind: "mistral",
  label: "Mistral",
  description: "Mistral models through La Plateforme.",
  docsUrl: "https://docs.mistral.ai/getting-started/models/",
  origin: MISTRAL_ORIGIN,
  modelPlaceholder: "mistral-large-latest",
  keyPlaceholder: "Your Mistral API key",
});
