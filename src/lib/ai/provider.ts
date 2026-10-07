import { createOpenAI } from "@ai-sdk/openai";
import { gateway } from "ai";
import { resilientModel } from "@/lib/ai/invoke";
import { logModelErrors } from "@/lib/ai/provider-error";
import { stubModel } from "@/lib/ai/stub";
import type { BaseUrlAllowlist } from "@/lib/ai/base-url";
import { guardedFetch } from "@/lib/ai/guarded-fetch";
import type { ModelSettings } from "@/lib/ai/model-config";
import { config } from "@/lib/config";

/**
 * Provider-agnostic model selection.
 *
 * This file builds models; which one a request gets is decided per request
 * in `model-resolution.ts` (#331): a person's, a workspace's, or this
 * environment's. For the environment, the provider and model are chosen
 * entirely from these variables. We do NOT
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
 * What every `streamObject`/`streamText` call spreads in: the model the
 * route resolved for this caller and workspace (#331), the
 * SDK's own retry turned off, because the model's middleware already retries
 * (with jitter, inside a deadline) and two loops would multiply,
 * {@link PROVIDER_OPTIONS}, and the `onError` that logs a failed call through
 * the redacting log instead of the SDK's raw console dump (#343).
 * `test/ai-invoke.test.ts` fails on a call site that does not use it, or that
 * replaces its `onError`.
 */
export function modelSettings(model: Model) {
  return {
    model,
    maxRetries: 0,
    providerOptions: PROVIDER_OPTIONS,
    onError: logModelErrors(),
  } as const;
}

/** A model ready to call: a provider's, wrapped with the deadline and retry. */
export type Model = ReturnType<typeof resilient>;

function resilient(model: Parameters<typeof resilientModel>[0]) {
  return resilientModel(model, {
    timeoutMs: config.aiRequestTimeoutMs,
    maxRetries: config.aiMaxRetries,
  });
}

/**
 * The environment's model: the last level of the resolution in
 * `model-resolution.ts` (#331), and the only one a script or a demo uses.
 */
export function getModel(): Model {
  return resilient(baseModel());
}

/**
 * A model configured in the app (#331), for a workspace or a person. Unlike
 * the environment's, everything comes from the arguments: the base URL is
 * always passed, so `OPENAI_BASE_URL` is never read, and the key is always a
 * string, so `OPENAI_API_KEY` is never read either (an endpoint that needs no
 * key gets an empty one). Every request goes through the guarded fetch, which
 * holds the base URL to the address rules in `base-url.ts` on each
 * connection.
 */
export function configuredModel(
  settings: ModelSettings,
  apiKey: string | null,
  allowlist: BaseUrlAllowlist,
): Model {
  switch (settings.provider) {
    case "openai-compatible": {
      const openai = createOpenAI({
        baseURL: settings.baseUrl,
        apiKey: apiKey ?? "",
        fetch: guardedFetch(settings.baseUrl, allowlist),
      });
      return resilient(
        settings.api === "chat" ? openai.chat(settings.model) : openai(settings.model),
      );
    }
  }
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
    // Passed explicitly, and never the empty string: the SDK also reads
    // these from the environment on its own, at import, and refuses an empty
    // `OPENAI_BASE_URL` there — which is why an empty value is dropped before
    // this module loads (`src/lib/env-hygiene.ts`, #350).
    const openai = createOpenAI({
      baseURL: process.env.OPENAI_BASE_URL || undefined,
      apiKey: process.env.OPENAI_API_KEY || undefined,
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
