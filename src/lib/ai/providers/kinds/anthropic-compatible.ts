import { z } from "zod";
import {
  baseUrlField,
  baseUrlInput,
  defineProviderKind,
  modelField,
  modelInput,
  OptionalApiKeyCredentials,
  optionalApiKeyField,
} from "@/lib/ai/providers/types";

/**
 * Any endpoint that speaks Anthropic's Messages API (#592): an aggregator
 * that serves Claude only over `/messages` (OpenCode Zen, whose Claude
 * models refuse both OpenAI protocols, #337), LiteLLM, a company proxy. Like
 * `openai-compatible`, a person types the endpoint, so its base URL is held
 * to the base URL guard (`ai/base-url.ts`) on save and on every connection,
 * and the key is optional.
 */
export const anthropicCompatibleKind = defineProviderKind({
  kind: "anthropic-compatible",
  label: "Anthropic-compatible",
  description:
    "Any endpoint that speaks Anthropic's Messages API: OpenCode Zen's Claude models, LiteLLM, a proxy.",
  docsUrl: "https://docs.anthropic.com/en/api/messages",
  settings: z
    .object({
      provider: z.literal("anthropic-compatible"),
      baseUrl: baseUrlField(),
      model: modelField(),
    })
    .strict(),
  credentials: OptionalApiKeyCredentials,
  fields: [
    baseUrlInput("https://opencode.ai/zen/v1"),
    modelInput("claude-sonnet-5-5"),
    optionalApiKeyField("sk-…"),
  ],
  endpoint: (settings) => settings.baseUrl,
  userSetsEndpoint: true,
  listsModels: true,
});
