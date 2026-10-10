import { APICallError, createIdGenerator, type UIMessage } from "ai";
import { buildDataChatPrompt, streamDataChat } from "@/lib/ai/data-chat";
import { ModelTimeoutError } from "@/lib/ai/invoke";
import { recordGeneration } from "@/lib/ai/log";
import { requireModel } from "@/lib/ai/model-resolution";
import { providerHttpError } from "@/lib/ai/provider-error";
import { audit } from "@/lib/audit";
import type { Identity } from "@/lib/auth/claims";
import { conversationScope, conversationTitle } from "@/lib/chat/conversations";
import type { Dashboard, TimeRange } from "@/lib/ir";
import { enforceLlmLimits } from "@/lib/limits/llm";
import { log } from "@/lib/log";
import { recordLlmRepair } from "@/lib/metrics";
import type { SourceRecord } from "@/lib/registry";
import type { VariableValues } from "@/lib/sql/variables";
import { serverKind } from "@/lib/sources/server/registry";
import { workspacePromptFor } from "@/lib/workspace-prompt-service";

/** An answer's id, made on the server: a kept conversation's row key. */
const messageId = createIdGenerator({ prefix: "msg", size: 16 });

/**
 * One Chat turn (#416), kept or not: the model resolved and admitted for the
 * workspace, the prompt, the audit and the generation log, and the stream.
 * The caller has authorized the sources and decided the history; `onEnd`
 * receives the finished messages, which a kept conversation stores.
 *
 * Rate-limited and budgeted per workspace, like every model call; a
 * `showPanel` repair is a second call whose usage is recorded with it.
 */
export async function chatTurnResponse(input: {
  identity: Identity;
  workspaceId: string;
  sources: SourceRecord[];
  timeRange: TimeRange;
  variables?: VariableValues | null;
  /** The history, then the new question last. */
  messages: UIMessage[];
  /** The kept conversation, for the audit rows; absent when nothing is kept. */
  conversationId?: string;
  /** The dashboard whose chat this continues: its panels go in the prompt. */
  dashboard?: { id: string; spec: Dashboard };
  abortSignal: AbortSignal;
  onEnd?: (messages: UIMessage[]) => Promise<void>;
}): Promise<Response> {
  const { identity, workspaceId, sources, messages, conversationId } = input;
  const resolved = await requireModel({ identity, workspaceId });
  const usage = await enforceLlmLimits({
    identity,
    workspaceId,
    route: "chat",
    model: resolved.modelId,
  });

  // The workspace's own context (#66). Advisory: unreadable, the turn runs on
  // the base prompt rather than failing.
  const workspacePrompt = await workspacePromptFor(sources).catch((error: unknown) => {
    log.warn("workspace_prompt.load_failed", { workspaceId, error });
    return null;
  });
  const catalog = sources.map((s) => serverKind(s).catalogPrompt(s)).join("\n\n");
  const question = messages.at(-1);
  const promptText = (question && conversationTitle(question)) ?? "";
  const where = {
    ...(conversationId ? { conversationId } : { kept: false }),
    ...(input.dashboard ? { dashboardId: input.dashboard.id } : {}),
  };

  audit({
    actor: identity,
    action: "chat.turn",
    workspaceId,
    resource: conversationId ? { type: "conversation", id: conversationId } : null,
    detail: {
      ...where,
      messageCount: messages.length,
      modelConfig: resolved.source,
      timeRange: input.timeRange,
      sourceIds: sources.map((s) => s.id),
    },
  });

  const result = await streamDataChat({
    system: buildDataChatPrompt({
      sources,
      timeRange: input.timeRange,
      workspacePrompt,
      ...(input.dashboard ? { dashboard: { spec: input.dashboard.spec } } : {}),
    }),
    scope: conversationScope(
      { timeRange: input.timeRange, variables: input.variables ?? null },
      sources,
      identity,
      input.timeRange,
      input.dashboard?.spec,
    ),
    model: resolved.model,
    messages,
    abortSignal: input.abortSignal,
    onUsage: usage.record,
    onRepair: ({ usage: used, repaired }) => {
      usage.record(used);
      recordLlmRepair("chat", repaired ? "repaired" : "failed");
    },
    // Each statement is the caller's execution, on their authority (#30).
    onQuery: (q) =>
      audit({
        actor: identity,
        action: "query.execute",
        workspaceId,
        resource: { type: "source", id: q.sourceId },
        outcome: q.outcome,
        detail: {
          via: "chat",
          ...where,
          ...(q.panelId ? { panelId: q.panelId } : {}),
          ...(q.promql !== undefined ? { promql: q.promql } : { sql: q.sql }),
          stage: q.stage,
        },
      }),
    // Every drawn spec, accepted or refused, is a generation a source-admin can
    // read back, as for a dashboard generation.
    onPanel: (p) =>
      recordGeneration({
        workspaceId,
        createdBy: identity.sub,
        mode: "chat",
        sourceId: p.sourceId,
        prompt: promptText,
        catalog,
        spec: p.outcome === "accepted" ? p.spec : null,
        model: resolved.modelId,
        modelConfig: resolved.source,
        error: p.error,
      }),
  });

  return result.toUIMessageStreamResponse({
    originalMessages: messages,
    generateMessageId: messageId,
    // A provider failure names the setting to fix (#337); anything else keeps
    // the SDK default's reticence.
    onError: (error) =>
      APICallError.isInstance(error) || error instanceof ModelTimeoutError
        ? providerHttpError(error).message
        : "Something went wrong while answering. Try again.",
    onEnd: input.onEnd
      ? async ({ messages: finished }) => {
          try {
            await input.onEnd?.(finished);
          } catch (err) {
            // The answer already reached the browser; failing to keep it is a
            // log line, not a broken response.
            log.error("chat.persist_failed", { conversationId, err });
          }
        }
      : undefined,
  });
}
