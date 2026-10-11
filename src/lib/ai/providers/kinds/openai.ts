import { fixedApiKeyKind } from "@/lib/ai/providers/kinds/fixed";

export const OPENAI_ORIGIN = "https://api.openai.com";

export const openaiKind = fixedApiKeyKind({
  kind: "openai",
  label: "OpenAI",
  description: "OpenAI's own API, with your OpenAI key.",
  docsUrl: "https://platform.openai.com/docs/models",
  origin: OPENAI_ORIGIN,
  modelPlaceholder: "gpt-5",
  keyPlaceholder: "sk-…",
});
