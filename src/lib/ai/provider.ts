import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

/**
 * Provider-agnostic model selection.
 *
 * The provider and model are chosen entirely from the environment. We do NOT
 * hard-code any model catalog or model-specific data. Two strategies:
 *
 *   AI_PROVIDER=gateway            -> pass the model id string straight to the
 *                                     AI SDK, which routes via the AI Gateway
 *                                     (uses AI_GATEWAY_API_KEY from the env).
 *   AI_PROVIDER=openai-compatible  -> use an OpenAI-compatible endpoint via
 *                                     OPENAI_BASE_URL + OPENAI_API_KEY.
 *
 * OPEN DECISION: which concrete provider/model to run is deliberately left to
 * deployment (see docs/ARCHITECTURE.md). `AI_MODEL` selects it; there is no
 * baked-in default model.
 */

export function getModel(): LanguageModel {
  const modelId = process.env.AI_MODEL;
  if (!modelId) {
    throw new Error(
      "AI_MODEL is not set. Configure AI_PROVIDER and AI_MODEL (see .env.example).",
    );
  }

  const provider = process.env.AI_PROVIDER || "openai-compatible";

  if (provider === "gateway") {
    // The AI SDK treats a bare model id string as a gateway model reference.
    return modelId;
  }

  if (provider === "openai-compatible") {
    const openai = createOpenAI({
      baseURL: process.env.OPENAI_BASE_URL || undefined,
      apiKey: process.env.OPENAI_API_KEY,
    });
    // Two OpenAI-compatible surfaces exist and they are NOT interchangeable:
    //   - Responses API  (`/responses`)         -> SDK default, `openai(id)`
    //   - Chat Completions (`/chat/completions`) -> `openai.chat(id)`
    // OpenRouter works with the SDK default (Responses); forcing Chat
    // Completions breaks it. OpenCode Go/Zen only exposes Chat Completions.
    // Default to the SDK's Responses path (old behavior) and let deployments
    // opt into Chat Completions with OPENAI_API=chat.
    if (process.env.OPENAI_API === "chat") {
      return openai.chat(modelId);
    }
    return openai(modelId);
  }

  throw new Error(`unknown AI_PROVIDER: ${provider}`);
}
