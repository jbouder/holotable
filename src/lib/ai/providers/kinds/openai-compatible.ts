import { z } from "zod";
import {
  API_FIELD_OPTIONS,
  defineProviderKind,
  modelField,
  modelInput,
  OPENAI_APIS,
  PROVIDER_LIMITS,
} from "@/lib/ai/providers/types";

/**
 * Any endpoint that speaks the OpenAI protocol (#331): OpenRouter, Groq,
 * Together, Ollama, vLLM, LM Studio, a company proxy. The one kind whose
 * endpoint a person types, so its base URL is held to the base URL guard
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
      baseUrl: z
        .url({ protocol: /^https?$/, error: "must be an http(s) URL" })
        .max(PROVIDER_LIMITS.baseUrl),
      model: modelField(),
      api: z.enum(OPENAI_APIS).default("responses"),
    })
    .strict(),
  credentials: z
    .object({ apiKey: z.string().trim().max(PROVIDER_LIMITS.secret).optional() })
    .strict(),
  fields: [
    {
      name: "baseUrl",
      in: "settings",
      label: "Base URL",
      placeholder: "https://openrouter.ai/api/v1",
      input: "url",
      maxLength: PROVIDER_LIMITS.baseUrl,
    },
    modelInput("openai/gpt-4o-mini"),
    {
      name: "api",
      in: "settings",
      label: "API",
      input: "select",
      options: API_FIELD_OPTIONS,
      maxLength: 16,
    },
    {
      name: "apiKey",
      in: "credentials",
      label: "API key",
      placeholder: "sk-…",
      secret: true,
      optional: true,
      maxLength: PROVIDER_LIMITS.secret,
    },
  ],
  endpoint: (settings) => settings.baseUrl,
  userSetsEndpoint: true,
});
