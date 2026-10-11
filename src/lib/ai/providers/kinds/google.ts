import { fixedApiKeyKind } from "@/lib/ai/providers/kinds/fixed";

export const GOOGLE_ORIGIN = "https://generativelanguage.googleapis.com";

export const googleKind = fixedApiKeyKind({
  kind: "google",
  label: "Google Gemini",
  description: "Gemini models through the Gemini API (Google AI Studio key).",
  docsUrl: "https://ai.google.dev/gemini-api/docs/models",
  origin: GOOGLE_ORIGIN,
  modelPlaceholder: "gemini-2.5-pro",
  keyPlaceholder: "AIza…",
});
