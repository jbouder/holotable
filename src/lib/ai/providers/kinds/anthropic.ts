import { fixedApiKeyKind } from "@/lib/ai/providers/kinds/fixed";

export const ANTHROPIC_ORIGIN = "https://api.anthropic.com";

export const anthropicKind = fixedApiKeyKind({
  kind: "anthropic",
  label: "Anthropic",
  description: "Claude models through Anthropic's API.",
  docsUrl: "https://docs.anthropic.com/en/docs/about-claude/models",
  origin: ANTHROPIC_ORIGIN,
  modelPlaceholder: "claude-sonnet-5-5",
  keyPlaceholder: "sk-ant-…",
});
