import { fixedApiKeyKind } from "@/lib/ai/providers/kinds/fixed";

export const GATEWAY_ORIGIN = "https://ai-gateway.vercel.sh";

export const gatewayKind = fixedApiKeyKind({
  kind: "gateway",
  label: "Vercel AI Gateway",
  description: "Any model the AI Gateway routes to, named provider/model.",
  docsUrl: "https://vercel.com/docs/ai-gateway/models-and-providers",
  origin: GATEWAY_ORIGIN,
  modelPlaceholder: "anthropic/claude-sonnet-5-5",
  keyPlaceholder: "vck_…",
});
