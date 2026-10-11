import { resilientModel } from "@/lib/ai/invoke";
import { logModelErrors } from "@/lib/ai/provider-error";
import type { BaseUrlAllowlist } from "@/lib/ai/base-url";
import type { Credentials, ModelSettings } from "@/lib/ai/providers/registry";
import { environmentModel } from "@/lib/ai/providers/server/environment";
import { OPENAI_PROVIDER_OPTIONS } from "@/lib/ai/providers/server/openai-compatible";
import { buildModel, providerOptionsFor } from "@/lib/ai/providers/server/registry";
import type { ProviderOptions } from "@/lib/ai/providers/server/types";
import { config, type Environment } from "@/lib/config";

/**
 * Provider-agnostic model selection.
 *
 * This file wraps models; which one a request gets is decided per request
 * in `model-resolution.ts` (#331): a person's, a workspace's, or this
 * environment's. How a model of each provider kind is built is the kind's
 * server half under `providers/server/` (#438); nothing here names a vendor.
 * We do NOT hard-code any model catalog or model-specific data: which
 * concrete provider and model to run is left to deployment (see
 * docs/src/content/docs/admin/ai-provider.md).
 *
 * Every model is wrapped with the deadline and retry from ./invoke.ts (#22).
 */

/**
 * The provider options of the environment's model, and of any model whose
 * kind is not known here: OpenAI's strict structured outputs turned off
 * (#336). Providers that are not OpenAI ignore the option.
 */
export const PROVIDER_OPTIONS: ProviderOptions = OPENAI_PROVIDER_OPTIONS;

/** Each configured model's kind's options, set when it is built. */
const optionsByModel = new WeakMap<object, ProviderOptions>();

/**
 * What every `streamObject`/`streamText` call spreads in: the model the
 * route resolved for this caller and workspace (#331), the
 * SDK's own retry turned off, because the model's middleware already retries
 * (with jitter, inside a deadline) and two loops would multiply, the
 * provider options of the model's kind (#438), and the `onError` that logs a
 * failed call through the redacting log instead of the SDK's raw console
 * dump (#343). `test/ai-invoke.test.ts` fails on a call site that does not
 * use it, or that replaces its `onError`.
 */
export function modelSettings(model: Model) {
  return {
    model,
    maxRetries: 0,
    providerOptions: optionsByModel.get(model) ?? PROVIDER_OPTIONS,
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
export function getModel(env: Environment = process.env): Model {
  return resilient(environmentModel(env));
}

/**
 * A model configured in the app (#331, #438), for a workspace or a person,
 * of any provider kind. Everything comes from the arguments: the kind's
 * server half passes the credentials and the vendor's URL to its SDK
 * explicitly, so nothing is read from the server's environment, and every
 * request goes through the fetch `providers/server/registry.ts` picks for
 * the kind (the base URL guard for a typed endpoint, the vendor's origin
 * otherwise).
 */
export function configuredModel(
  settings: ModelSettings,
  credentials: Credentials,
  allowlist: BaseUrlAllowlist,
): Model {
  const model = resilient(buildModel(settings, credentials, allowlist));
  optionsByModel.set(model, providerOptionsFor(settings));
  return model;
}
