import { createOpenAI } from "@ai-sdk/openai";
import { gateway } from "ai";
import type { BaseModel } from "@/lib/ai/providers/server/types";
import { stubModel } from "@/lib/ai/stub";
import type { Environment } from "@/lib/config";

/**
 * The server's own model, from `AI_PROVIDER`, `AI_MODEL`, `OPENAI_BASE_URL`,
 * `OPENAI_API_KEY`, `OPENAI_API` and `AI_GATEWAY_API_KEY`. The operator's
 * configuration, so unlike a stored model it may read the environment and its
 * base URL is not held to the guard. Moved here unchanged from
 * `ai/provider.ts` (#438), so every `@ai-sdk/*` import is under this
 * directory.
 *
 *   AI_PROVIDER=gateway            -> the model id string through the AI
 *                                     Gateway (AI_GATEWAY_API_KEY).
 *   AI_PROVIDER=openai-compatible  -> an OpenAI-compatible endpoint via
 *                                     OPENAI_BASE_URL + OPENAI_API_KEY.
 *   AI_PROVIDER=stub               -> recorded specs, no network (#88).
 */
export function environmentModel(env: Environment = process.env): BaseModel {
  const provider = env.AI_PROVIDER || "openai-compatible";
  // Checked before AI_MODEL: the stub has no model to name.
  if (provider === "stub") return stubModel();

  const modelId = env.AI_MODEL;
  if (!modelId) {
    throw new Error(
      "AI_MODEL is not set. Configure AI_PROVIDER and AI_MODEL (see .env.example).",
    );
  }

  if (provider === "gateway") {
    // What a bare model id string resolves to; spelled out so it can be wrapped.
    return gateway(modelId);
  }

  if (provider === "openai-compatible") {
    // Passed explicitly, and never the empty string: the SDK also reads
    // these from the environment on its own, at import, and refuses an empty
    // `OPENAI_BASE_URL` there — which is why an empty value is dropped before
    // this module loads (`src/lib/env-hygiene.ts`, #350).
    const openai = createOpenAI({
      baseURL: env.OPENAI_BASE_URL || undefined,
      apiKey: env.OPENAI_API_KEY || undefined,
    });
    // Two OpenAI-compatible surfaces exist and they are NOT interchangeable:
    //   - Responses API  (`/responses`)         -> SDK default, `openai(id)`
    //   - Chat Completions (`/chat/completions`) -> `openai.chat(id)`
    // OpenRouter works with the SDK default (Responses); forcing Chat
    // Completions breaks it. OpenCode Go/Zen only exposes Chat Completions.
    // Default to the SDK's Responses path and let deployments opt into Chat
    // Completions with OPENAI_API=chat.
    if (env.OPENAI_API === "chat") return openai.chat(modelId);
    return openai(modelId);
  }

  throw new Error(`unknown AI_PROVIDER: ${provider}`);
}
