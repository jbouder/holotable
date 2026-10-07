import { createOpenAI } from "@ai-sdk/openai";
import { gateway } from "ai";
import { resilientModel } from "@/lib/ai/invoke";
import { stubModel } from "@/lib/ai/stub";
import { config } from "@/lib/config";

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
 *   AI_PROVIDER=stub               -> recorded specs, no network (#88); for
 *                                     the end-to-end suite, see ./stub.ts.
 *
 * OPEN DECISION: which concrete provider/model to run is deliberately left to
 * deployment (see docs/src/content/docs/operations/ai-provider.md). `AI_MODEL`
 * selects it; there is no baked-in default model.
 *
 * Every model is wrapped with the deadline and retry from ./invoke.ts (#22).
 */

/**
 * Provider options every call carries.
 *
 * OpenAI's strict structured outputs (the provider's default) accept a schema
 * only when every property is required, and refuse the IR, whose optional
 * fields (`timeField`, `description`, `options` …) are the point. The refusal
 * comes before any generation, on every request, so a deployment pointed at an
 * OpenAI model could generate nothing (#336). Non-strict, the schema is still
 * sent and followed; what the model returns is validated against the IR either
 * way, and repaired once when it fails (#21). Providers that are not OpenAI
 * ignore the option.
 */
export const PROVIDER_OPTIONS = {
  openai: { strictJsonSchema: false },
} as const;

/**
 * What every `streamObject`/`streamText` call spreads in: the model, the
 * SDK's own retry turned off, because the model's middleware already retries
 * (with jitter, inside a deadline) and two loops would multiply, and
 * {@link PROVIDER_OPTIONS}. `test/ai-invoke.test.ts` fails on a call site that
 * does not use it.
 */
export function modelSettings() {
  return { model: getModel(), maxRetries: 0, providerOptions: PROVIDER_OPTIONS } as const;
}

export function getModel() {
  return resilientModel(baseModel(), {
    timeoutMs: config.aiRequestTimeoutMs,
    maxRetries: config.aiMaxRetries,
  });
}

function baseModel() {
  const provider = process.env.AI_PROVIDER || "openai-compatible";
  // Checked before AI_MODEL: the stub has no model to name.
  if (provider === "stub") return stubModel();

  const modelId = process.env.AI_MODEL;
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
