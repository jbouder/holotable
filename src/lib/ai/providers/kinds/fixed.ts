import { z } from "zod";
import {
  ApiKeyCredentials,
  apiKeyField,
  defineProviderKind,
  modelField,
  modelInput,
} from "@/lib/ai/providers/types";

/**
 * A vendor with one fixed origin, one model id and one API key: OpenAI,
 * Anthropic, Google, the AI Gateway, Mistral and xAI. Nobody types where the
 * requests go, so there is no base URL to guard; every request is still held
 * to the vendor's origin, and no redirect is followed.
 */
export function fixedApiKeyKind<Name extends string>(spec: {
  kind: Name;
  label: string;
  description: string;
  docsUrl: string;
  origin: string;
  modelPlaceholder: string;
  keyPlaceholder: string;
}) {
  return defineProviderKind({
    kind: spec.kind,
    label: spec.label,
    description: spec.description,
    docsUrl: spec.docsUrl,
    settings: z.object({ provider: z.literal(spec.kind), model: modelField() }).strict(),
    credentials: ApiKeyCredentials,
    fields: [modelInput(spec.modelPlaceholder), apiKeyField(spec.keyPlaceholder)],
    endpoint: () => spec.origin,
    userSetsEndpoint: false,
  });
}
