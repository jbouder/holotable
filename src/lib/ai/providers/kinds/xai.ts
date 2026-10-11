import { fixedApiKeyKind } from "@/lib/ai/providers/kinds/fixed";

export const XAI_ORIGIN = "https://api.x.ai";

export const xaiKind = fixedApiKeyKind({
  kind: "xai",
  label: "xAI",
  description: "Grok models through xAI's API.",
  docsUrl: "https://docs.x.ai/docs/models",
  origin: XAI_ORIGIN,
  modelPlaceholder: "grok-4",
  keyPlaceholder: "xai-…",
});
