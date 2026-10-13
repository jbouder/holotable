import { z } from "zod";
import {
  API_FIELD_OPTIONS,
  baseUrlField,
  baseUrlInput,
  defineProviderKind,
  modelField,
  modelInput,
  OPENAI_APIS,
  OptionalApiKeyCredentials,
  optionalApiKeyField,
} from "@/lib/ai/providers/types";

/**
 * Any endpoint that speaks the OpenAI protocol (#331): OpenRouter, Groq,
 * Together, Ollama, vLLM, LM Studio, a company proxy. A kind whose endpoint
 * a person types, so its base URL is held to the base URL guard
 * (`ai/base-url.ts`) on save and on every connection. The key is optional,
 * for a local endpoint that needs none.
 */
export const openaiCompatibleKind = defineProviderKind({
  kind: "openai-compatible",
  label: "OpenAI-compatible",
  description:
    "Any endpoint that speaks the OpenAI API: OpenRouter, Groq, Together, Ollama, vLLM, LM Studio.",
  docsUrl: "https://platform.openai.com/docs/api-reference/introduction",
  settings: z
    .object({
      provider: z.literal("openai-compatible"),
      baseUrl: baseUrlField(),
      model: modelField(),
      api: z.enum(OPENAI_APIS).default("responses"),
    })
    .strict(),
  credentials: OptionalApiKeyCredentials,
  fields: [
    baseUrlInput("https://openrouter.ai/api/v1"),
    modelInput("openai/gpt-4o-mini"),
    {
      name: "api",
      in: "settings",
      label: "API",
      input: "select",
      options: API_FIELD_OPTIONS,
      maxLength: 16,
    },
    optionalApiKeyField("sk-…"),
  ],
  endpoint: (settings) => settings.baseUrl,
  userSetsEndpoint: true,
  listsModels: true,
});
