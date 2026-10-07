import { generateText } from "ai";
import { type Model, modelSettings } from "@/lib/ai/provider";
import { providerErrorMessage } from "@/lib/ai/provider-error";
import type { ModelTestResult } from "@/lib/ai/model-test-result";
import type { LlmUsageRecorder } from "@/lib/limits/llm";

/**
 * "Test connection" on the model settings pages (#331): one minimal model
 * call, so a wrong base URL, model id or key is found when it is entered and
 * not on the next person's generation. The call is admitted and its usage
 * spent like any other.
 */

export type { ModelTestResult } from "@/lib/ai/model-test-result";

export async function testModel(
  model: Model,
  usage: LlmUsageRecorder,
): Promise<ModelTestResult> {
  const started = Date.now();
  try {
    const result = await generateText({
      ...modelSettings(model),
      prompt: "Reply with the single word OK.",
      maxOutputTokens: 16,
    });
    usage.record(result.usage);
    return {
      ok: true,
      model: result.response.modelId,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      message: providerErrorMessage(error),
    };
  }
}
