import { type Environment, localModelDetection } from "@/lib/config";

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
 * visitor to a demo without a key sees. Where the server looks for a model on
 * this machine (#607, in local mode by default) it says how to have one found.
 */
export function aiUnavailableMessage(problem: string, env: Environment = {}): string {
  if (problem === "AI_PROVIDER") {
    return "AI_PROVIDER is not recognized, so no model can be called. Set it to openai-compatible or gateway.";
  }
  const base =
    problem === "AI_GATEWAY_API_KEY"
      ? "No model configured. Set AI_MODEL and AI_GATEWAY_API_KEY on the server to generate with AI."
      : "No model configured. Set AI_MODEL and OPENAI_API_KEY on the server to generate with AI.";
  return localModelDetection(env) ? `${base} ${LOCAL_MODEL_HINT}` : base;
}

/** The sentence a server that detects local models adds to "No model configured". */
export const LOCAL_MODEL_HINT =
  "Or, on this machine, start Ollama or LM Studio and choose Re-scan on the Models page, then pick a model it found.";

/** The message for this server's environment, or `null` when a model is configured. */
export function aiUnavailable(env: Environment = process.env): string | null {
  const problem = aiConfigProblem(env);
  return problem ? aiUnavailableMessage(problem, env) : null;
}
