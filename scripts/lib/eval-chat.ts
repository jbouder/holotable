import type { LanguageModel, UIMessage } from "ai";
import { z } from "zod";
import {
  buildDataChatPrompt,
  type ChatPanelOutcome,
  type ChatScope,
  streamDataChat,
} from "@/lib/ai/data-chat";
import type { Model } from "@/lib/ai/provider";
import { parseGroups } from "@/lib/auth/claims";
import type { QueryPanel, TimeRange } from "@/lib/ir";
import type { SourceRecord } from "@/lib/registry";

/*
 * Chat turns in the eval harness (#416, phase 7).
 *
 * A Chat turn is not one `streamObject` answer but a few model steps with
 * tool calls between them, so a case records the steps: each one's text and
 * the tool calls it made, inputs as the model wrote them. Replay plays them
 * back in order through the real engine (`streamDataChat`), so the guard,
 * the IR and the `showPanel` tool decide again what would have been drawn.
 *
 * Nothing runs against a database: the executor answers every statement with
 * no rows, which is all grading needs. The grade is over the panels the server
 * accepted, and whether the turn reached for rows in words (`runQuery`).
 */

/** One step of a recorded turn. */
export const ChatStep = z
  .object({
    text: z.string(),
    toolCalls: z.array(z.object({ toolName: z.string(), input: z.string() }).strict()),
  })
  .strict();
export type ChatStep = z.infer<typeof ChatStep>;

/** The window every chat case runs over; the server resolves it, as always. */
export const CHAT_EVAL_RANGE: TimeRange = { from: "now-24h", to: "now" };

/** What a chat case's request is, for the recording's digest. */
export function chatRequest(source: SourceRecord, prompt: string) {
  return {
    system: buildDataChatPrompt({ sources: [source], timeRange: CHAT_EVAL_RANGE }),
    prompt,
    schemaName: "chat",
  };
}

export interface ChatTurn {
  steps: ChatStep[];
  /** The `showPanel` specs the server drew, after the guard. */
  drawn: QueryPanel[];
  /** The `showPanel` calls it refused, with why. */
  refused: { error: string }[];
  /** How many `runQuery` calls the turn made. */
  runQueries: number;
  text: string;
  modelId: string;
  /** The turn finished; a provider failure did not. */
  completed: boolean;
  error?: unknown;
}

/** Run one chat case's question through the engine against `model`. */
export async function runChatTurn(
  source: SourceRecord,
  prompt: string,
  model: LanguageModel,
): Promise<ChatTurn> {
  const scope: ChatScope = {
    sources: [source],
    timeRange: CHAT_EVAL_RANGE,
    identity: parseGroups("eval", [`/workspaces/${source.workspaceId}/viewer`]),
  };
  const panels: ChatPanelOutcome[] = [];
  const message: UIMessage = {
    id: "eval-question",
    role: "user",
    parts: [{ type: "text", text: prompt }],
  };
  let error: unknown;
  const result = await streamDataChat({
    system: chatRequest(source, prompt).system,
    scope,
    model: model as Model,
    messages: [message],
    execute: async () => ({ columns: [], rows: [] }),
    onPanel: (p) => panels.push(p),
  });
  let text = "";
  try {
    text = await result.text;
  } catch (err) {
    error = err;
  }
  const steps = error === undefined ? await result.steps : [];
  return {
    steps: steps.map((s) => ({
      text: s.text,
      toolCalls: s.toolCalls.map((c) => ({
        toolName: c.toolName,
        input: JSON.stringify(c.input),
      })),
    })),
    drawn: panels
      .filter((p) => p.outcome === "accepted")
      .map((p) => p.spec as QueryPanel),
    refused: panels
      .filter((p) => p.outcome === "refused")
      .map((p) => ({ error: p.error ?? "refused" })),
    runQueries: steps.flatMap((s) => s.toolCalls).filter((c) => c.toolName === "runQuery")
      .length,
    text,
    modelId: steps.at(-1)?.response.modelId ?? "",
    completed: error === undefined,
    error,
  };
}

/**
 * A model that plays a recorded turn back: its `n`th call answers with the
 * `n`th step's tool calls, or its text when it made none.
 */
export function chatReplayModel(modelId: string, steps: ChatStep[]): LanguageModel {
  type V4 = Extract<LanguageModel, { specificationVersion: "v4" }>;
  type Part =
    Awaited<ReturnType<V4["doStream"]>>["stream"] extends ReadableStream<infer P>
      ? P
      : never;
  const usage = {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  };
  let call = 0;
  const model: V4 = {
    specificationVersion: "v4",
    provider: "replay",
    modelId,
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error("replay supports streaming only")),
    async doStream() {
      const step = steps[call++] ?? { text: "", toolCalls: [] };
      const parts: Part[] = [
        { type: "stream-start", warnings: [] },
        { type: "response-metadata", id: "replay", modelId, timestamp: new Date(0) },
      ];
      if (step.text) {
        parts.push(
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: step.text },
          { type: "text-end", id: "t" },
        );
      }
      step.toolCalls.forEach((c, i) => {
        parts.push({
          type: "tool-call",
          toolCallId: `replay-${call}-${i}`,
          toolName: c.toolName,
          input: c.input,
        });
      });
      parts.push({
        type: "finish",
        finishReason:
          step.toolCalls.length > 0
            ? { unified: "tool-calls", raw: "tool_calls" }
            : { unified: "stop", raw: "stop" },
        usage,
      });
      return {
        stream: new ReadableStream<Part>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
  return model;
}
