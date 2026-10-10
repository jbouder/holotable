import { type ApiError, apiErrorFromThrown, readApiError } from "@/lib/errors";
import type { TimeRange } from "@/lib/ir";
import { type QueryRows, readWindow } from "@/lib/panel-query";

/**
 * The browser's half of `/api/chat` (#416). Each call names a conversation
 * and, for a panel, its id; none of them carries a statement, so the server
 * is the only thing that ever decides what runs.
 */

export type ChatCall<T> = { ok: true; value: T } | { ok: false; error: ApiError };

async function call<T>(
  url: string,
  init: RequestInit,
  read: (body: unknown) => T,
): Promise<ChatCall<T>> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: { "Content-Type": "application/json", ...init.headers },
    });
    if (!res.ok) return { ok: false, error: await readApiError(res) };
    return { ok: true, value: read(await res.json()) };
  } catch (err) {
    return { ok: false, error: apiErrorFromThrown(err) };
  }
}

/** Start a conversation over these sources; its id. */
export function createConversation(input: {
  sourceIds: string[];
  timeRange: TimeRange;
}): Promise<ChatCall<string>> {
  return call("/api/chat", { method: "POST", body: JSON.stringify(input) }, (body) => {
    const id = (body as { conversation?: { id?: unknown } }).conversation?.id;
    if (typeof id !== "string") throw new Error("no conversation id in the response");
    return id;
  });
}

/** Change a conversation's range or sources, or rename it. */
export function updateConversation(
  id: string,
  patch: { title?: string; sourceIds?: string[]; timeRange?: TimeRange },
): Promise<ChatCall<null>> {
  return call(
    `/api/chat/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(patch) },
    () => null,
  );
}

/** Run a drawn panel again, over the conversation's range or the one given. */
export function runChatPanel(
  conversationId: string,
  panelId: string,
  init: { timeRange?: TimeRange; signal?: AbortSignal } = {},
): Promise<ChatCall<QueryRows>> {
  return call(
    `/api/chat/${encodeURIComponent(conversationId)}/panels/${encodeURIComponent(panelId)}/run`,
    {
      method: "POST",
      body: JSON.stringify(init.timeRange ? { timeRange: init.timeRange } : {}),
      signal: init.signal,
    },
    readRows,
  );
}

/** A result body is trusted no further than its shape. */
export function readRows(body: unknown): QueryRows {
  const record = (typeof body === "object" && body !== null ? body : {}) as Partial<
    Record<keyof QueryRows, unknown>
  >;
  const window = readWindow(record.window);
  return {
    columns: Array.isArray(record.columns)
      ? record.columns.filter((c): c is string => typeof c === "string")
      : [],
    rows: Array.isArray(record.rows) ? (record.rows as Record<string, unknown>[]) : [],
    ...(window && { window }),
  };
}
