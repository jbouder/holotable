"use client";

import * as React from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import type { UIMessage } from "ai";
import {
  MessageSquare,
  X,
  Send,
  Loader2,
  Database,
  Sparkles,
  Square,
  Trash2,
} from "lucide-react";
import type { Panel } from "@/lib/ir";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { ErrorDisplay } from "@/components/ui/error-display";
import { apiErrorFromThrown } from "@/lib/errors";
import { type ChatCitation, citationsFromMessage } from "@/lib/chat-history";

/** What the chat needs to know about a panel: enough to cite it, nothing more. */
export type ChatPanel = Pick<Panel, "title" | "query">;

/**
 * Floating, read-only chat scoped to one dashboard. It talks to
 * /api/dashboards/[id]/chat, which reasons over the dashboard's panels and may
 * run guarded read-only queries against the dashboard's sources. The widget
 * never mutates the dashboard.
 *
 * History is persisted per person per dashboard (#82): the same route answers
 * `GET` with the stored conversation and `DELETE` to forget it. The load is
 * deferred until the widget is first opened — most readers never open it, and
 * a request per dashboard view for a panel nobody looked at is a request
 * nobody asked for.
 */
export function DashboardChat({
  dashboardId,
  dashboardTitle,
  panels,
  suggestions,
}: {
  dashboardId: string;
  dashboardTitle: string;
  /**
   * The dashboard's panels, for citations. Already client-visible — this is the
   * same spec the grid renders — and carries no connection detail.
   */
  panels: ChatPanel[];
  /** Derived from the spec on the server; no model call produced them. */
  suggestions: string[];
}) {
  const [open, setOpen] = React.useState(false);
  const [input, setInput] = React.useState("");
  const [loadedHistory, setLoadedHistory] = React.useState(false);

  const { messages, sendMessage, setMessages, status, stop, error, regenerate } = useChat(
    {
      transport: new DefaultChatTransport({
        api: `/api/dashboards/${dashboardId}/chat`,
      }),
    },
  );

  const busy = status === "submitted" || status === "streaming";
  const listRef = React.useRef<HTMLDivElement>(null);

  // Load the stored conversation once, on first open. A failure leaves the
  // widget usable and unseeded, which is exactly what it was before #82.
  React.useEffect(() => {
    if (!open || loadedHistory) return;
    setLoadedHistory(true);
    const controller = new AbortController();
    void fetch(`/api/dashboards/${dashboardId}/chat`, { signal: controller.signal })
      .then((r) => (r.ok ? (r.json() as Promise<{ messages: UIMessage[] }>) : null))
      .then((body) => {
        if (body?.messages?.length) setMessages(body.messages);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [open, loadedHistory, dashboardId, setMessages]);

  async function clear() {
    setMessages([]);
    setInput("");
    // Clearing is the documented way to forget a conversation, so it has to
    // reach the server; a local reset would come back on the next reload.
    try {
      await fetch(`/api/dashboards/${dashboardId}/chat`, { method: "DELETE" });
    } catch {
      // The list is already empty on screen; the next load will say otherwise.
    }
  }

  // `messages` and `status` are not read in the body: they are here so the list
  // scrolls to the bottom whenever a message arrives or streaming state changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate re-run triggers, not reads
  React.useEffect(() => {
    if (open) {
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    }
  }, [messages, status, open]);

  function ask(text: string) {
    if (!text.trim() || busy) return;
    // Fire and forget: useChat surfaces a failed send through `error`, which is
    // rendered below, so awaiting the promise here would handle it twice.
    void sendMessage({ text: text.trim() });
  }

  function submit() {
    if (!input.trim() || busy) return;
    ask(input);
    setInput("");
  }

  if (!open) {
    return (
      <Button
        variant="primary"
        size="icon"
        aria-label="Ask about this dashboard"
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-50 h-12 w-12 rounded-full shadow-lg"
      >
        <MessageSquare className="h-5 w-5" />
      </Button>
    );
  }

  const lastIsAnswer =
    !busy && messages.length > 0 && messages[messages.length - 1].role === "assistant";

  return (
    <div
      role="dialog"
      aria-label="Dashboard chat"
      className="fixed bottom-6 right-6 z-50 flex h-[560px] max-h-[calc(100vh-3rem)] w-[380px] max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-lg"
    >
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Sparkles className="h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">Ask this dashboard</p>
            <p className="truncate text-xs text-muted">{dashboardTitle}</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Clear chat"
              title="Clear chat"
              disabled={busy}
              onClick={() => void clear()}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close chat"
            onClick={() => setOpen(false)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-3">
        {messages.length === 0 ? (
          <EmptyState suggestions={suggestions} onPick={ask} />
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} panels={panels} />
            ))}
            {status === "submitted" && (
              <div className="flex items-center gap-2 text-xs text-muted">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
              </div>
            )}
            {lastIsAnswer && <Suggestions suggestions={suggestions} onPick={ask} />}
          </div>
        )}

        {error && (
          <ErrorDisplay
            error={apiErrorFromThrown(error)}
            className="mt-3"
            onRetry={() => regenerate()}
          />
        )}
      </div>

      <div className="border-t border-border p-3">
        <div className="flex items-end gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder="Ask about this dashboard…"
            className="max-h-28 min-h-[2.5rem] resize-none"
          />
          {busy ? (
            // A square, not a spinner: this is a button that does something,
            // and a spinner reads as "wait", which is the opposite.
            <Button
              variant="secondary"
              size="icon"
              aria-label="Stop generating"
              title="Stop generating"
              onClick={() => void stop()}
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </Button>
          ) : (
            <Button
              variant="primary"
              size="icon"
              aria-label="Send"
              disabled={!input.trim()}
              onClick={submit}
            >
              <Send className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyState({
  suggestions,
  onPick,
}: {
  suggestions: string[];
  onPick: (text: string) => void;
}) {
  return (
    <div className="flex h-full flex-col justify-center gap-3 text-center">
      <p className="text-sm text-muted">
        Ask questions about this dashboard&rsquo;s panels and data. I can fetch fresh
        numbers with read-only queries.
      </p>
      <Suggestions suggestions={suggestions} onPick={onPick} />
    </div>
  );
}

/**
 * Follow-up chips. Derived from the spec on the server — no second model call,
 * so they cost nothing and are the same every time for the same dashboard.
 */
function Suggestions({
  suggestions,
  onPick,
}: {
  suggestions: string[];
  onPick: (text: string) => void;
}) {
  if (suggestions.length === 0) return null;
  return (
    <fieldset className="flex flex-col gap-2" aria-label="Suggested questions">
      {suggestions.map((prompt) => (
        <button
          key={prompt}
          type="button"
          onClick={() => onPick(prompt)}
          className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-left text-xs text-foreground transition-colors hover:border-primary focus-visible:outline-2 focus-visible:outline-primary"
        >
          {prompt}
        </button>
      ))}
    </fieldset>
  );
}

type ChatMessage = ReturnType<typeof useChat>["messages"][number];

function MessageBubble({
  message,
  panels,
}: {
  message: ChatMessage;
  panels: ChatPanel[];
}) {
  const isUser = message.role === "user";
  const citations = isUser ? [] : citationsFromMessage(message, panels);

  return (
    <div className={cn("flex flex-col gap-1", isUser ? "items-end" : "items-start")}>
      {message.parts.map((part, i) => {
        if (part.type === "text") {
          if (!part.text) return null;
          return (
            // Parts are append-only within a message and never reordered.
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only stream parts
              key={i}
              className={cn(
                "max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm",
                isUser
                  ? "bg-primary text-primary-foreground"
                  : "bg-surface-2 text-foreground",
              )}
            >
              {part.text}
            </div>
          );
        }
        if (part.type === "tool-runQuery") {
          const running =
            part.state === "input-streaming" || part.state === "input-available";
          if (!running) return null;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only stream parts
            <div key={i} className="flex items-center gap-1.5 text-xs text-muted">
              <Loader2 className="h-3 w-3 animate-spin" />
              Querying data…
            </div>
          );
        }
        return null;
      })}
      {citations.map((citation) => (
        <CitationFootnote
          key={`${citation.sourceId}:${citation.sql}`}
          citation={citation}
        />
      ))}
    </div>
  );
}

/**
 * "Ran this query", expandable.
 *
 * A `<details>` rather than the panel dialog: the answer is the thing being
 * read, and a modal over it to check its working is the wrong shape. The SQL
 * is the model's own statement — the server added its time-range predicate on
 * top, which the note says rather than showing a statement that is neither
 * what the model wrote nor what the database saw.
 */
function CitationFootnote({ citation }: { citation: ChatCitation }) {
  return (
    <details className="max-w-[85%] rounded-lg border border-border bg-surface-2/60 text-xs">
      <summary className="flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-muted hover:text-foreground">
        <Database className="h-3 w-3 shrink-0" aria-hidden />
        <span className="truncate">
          Ran this query
          {citation.panelTitles.length > 0 && ` · ${citation.panelTitles.join(", ")}`}
        </span>
      </summary>
      <div className="space-y-2 border-t border-border px-2.5 py-2">
        <p className="text-muted">
          Source <span className="font-mono text-foreground">{citation.sourceId}</span>
        </p>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
          {citation.sql}
        </pre>
        <p className="text-muted">
          The dashboard time range was applied by the server on top of this statement.
        </p>
      </div>
    </details>
  );
}
