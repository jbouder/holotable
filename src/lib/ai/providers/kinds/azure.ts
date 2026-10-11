import { z } from "zod";
import {
  API_FIELD_OPTIONS,
  ApiKeyCredentials,
  apiKeyField,
  defineProviderKind,
  modelField,
  modelInput,
  OPENAI_APIS,
} from "@/lib/ai/providers/types";

/** An Azure OpenAI resource name: one DNS label on Microsoft's domain. */
export const AZURE_RESOURCE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** A dated API version (`2024-10-21`, `2025-04-01-preview`). */
const AZURE_API_VERSION = /^\d{4}-\d{2}-\d{2}(?:-preview)?$/;

/**
 * Azure OpenAI. The resource name is typed, but the host it names is always
 * `<resource>.openai.azure.com`, so there is no base URL to guard; `model` is
 * the deployment name. A dated `apiVersion` switches to the deployment-based
 * URLs that older API versions need; without one the `v1` API is used.
 */
export const azureKind = defineProviderKind({
  kind: "azure",
  label: "Azure OpenAI",
  description: "A model deployed on your Azure OpenAI resource.",
  docsUrl: "https://learn.microsoft.com/azure/ai-foundry/openai/concepts/models",
  settings: z
    .object({
      provider: z.literal("azure"),
      resourceName: z
        .string()
        .trim()
        .toLowerCase()
        .regex(
          AZURE_RESOURCE,
          "must be the resource's name, as in <name>.openai.azure.com",
        ),
      model: modelField("name the deployment"),
      apiVersion: z
        .string()
        .trim()
        .regex(AZURE_API_VERSION, "must be a dated version such as 2024-10-21")
        .optional(),
      api: z.enum(OPENAI_APIS).default("responses"),
    })
    .strict(),
  credentials: ApiKeyCredentials,
  fields: [
    {
      name: "resourceName",
      in: "settings",
      label: "Resource name",
      placeholder: "my-resource",
      help: "The <name> in <name>.openai.azure.com.",
      maxLength: 64,
    },
    modelInput("gpt-4o-prod", "Deployment"),
    {
      name: "apiVersion",
      in: "settings",
      label: "API version",
      placeholder: "Leave blank for the v1 API",
      optional: true,
      maxLength: 32,
    },
    {
      name: "api",
      in: "settings",
      label: "API",
      input: "select",
      options: API_FIELD_OPTIONS,
      maxLength: 16,
    },
    apiKeyField("Your resource's key"),
  ],
  endpoint: (settings) => `https://${settings.resourceName}.openai.azure.com`,
  userSetsEndpoint: false,
});
