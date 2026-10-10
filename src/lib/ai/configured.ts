import type { Environment } from "@/lib/config";

/**
 * Is a model configured well enough to try? Configuration only: nothing here
 * calls a provider, so it is cheap enough for a readiness probe and for every
 * render of a page with a prompt box.
 *
 * Returns the variable that is missing or wrong, or `null` when generation can
 * be attempted. A variable *name*, never a value, so the answer is safe to
 * hand to a browser.
 */
export function aiConfigProblem(env: Environment = process.env): string | null {
  const provider = env.AI_PROVIDER || "openai-compatible";
  // The recorded model (#88) needs neither a model id nor a key.
  if (provider === "stub") return null;
  if (!env.AI_MODEL) return "AI_MODEL";
  if (provider === "gateway") return env.AI_GATEWAY_API_KEY ? null : "AI_GATEWAY_API_KEY";
  if (provider === "openai-compatible")
    return env.OPENAI_API_KEY ? null : "OPENAI_API_KEY";
  return "AI_PROVIDER";
}

/**
 * What the generate, panel-edit and chat surfaces show in place of a
 * request that would fail (#251). Names the variables to set; demo mode makes
 * a missing model a warning rather than a boot failure, so this is what a
 * visitor to a demo without a key sees.
 */
export function aiUnavailableMessage(problem: string): string {
  if (problem === "AI_GATEWAY_API_KEY") {
    return "No model configured. Set AI_MODEL and AI_GATEWAY_API_KEY on the server to generate with AI.";
  }
  if (problem === "AI_PROVIDER") {
    return "AI_PROVIDER is not recognized, so no model can be called. Set it to openai-compatible or gateway.";
  }
  return "No model configured. Set AI_MODEL and OPENAI_API_KEY on the server to generate with AI.";
}

/** The message for this server's environment, or `null` when a model is configured. */
export function aiUnavailable(env: Environment = process.env): string | null {
  const problem = aiConfigProblem(env);
  return problem ? aiUnavailableMessage(problem) : null;
}
