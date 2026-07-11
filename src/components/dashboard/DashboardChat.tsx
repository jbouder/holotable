"use client";

import * as React from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import {
  MessageSquare,
  X,
  Send,
  Loader2,
  Database,
  Sparkles,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";

/**
 * Floating, read-only chat scoped to one dashboard. It talks to
 * /api/dashboards/[id]/chat, which reasons over the dashboard's panels and may
 * run guarded read-only queries against the dashboard's sources. History is
 * ephemeral (clears on reload). The widget never mutates the dashboard.
 */
export function DashboardChat({
  dashboardId,
  dashboardTitle,
}: {
  dashboardId: string;
  dashboardTitle: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [input, setInput] = React.useState("");

  const { messages, sendMessage, setMessages, status, stop, error } = useChat({
    transport: new DefaultChatTransport({
      api: `/api/dashboards/${dashboardId}/chat`,
    }),
  });

  const busy = status === "submitted" || status === "streaming";
  const listRef = React.useRef<HTMLDivElement>(null);

  function clear() {
    setMessages([]);
    setInput("");
  }

  React.useEffect(() => {
    if (open) {
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    }
  }, [messages, status, open]);

  function submit() {
    const text = input.trim();
    if (!text || busy) return;
    sendMessage({ text });
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
              onClick={clear}
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
          <EmptyState
            onPick={(text) => {
              if (busy) return;
              sendMessage({ text });
            }}
          />
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
            {status === "submitted" && (
              <div className="flex items-center gap-2 text-xs text-muted">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
              </div>
            )}
          </div>
        )}

        {error && (
          <p className="mt-3 text-xs text-danger">
            Something went wrong. Please try again.
          </p>
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
            <Button
              variant="ghost"
              size="icon"
              aria-label="Stop"
              onClick={() => stop()}
            >
              <Loader2 className="h-4 w-4 animate-spin" />
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

const EXAMPLE_PROMPTS = [
  "Summarize the current state of this dashboard.",
  "Which panel looks the most anomalous right now?",
  "What is the maximum value in the last hour?",
];

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex h-full flex-col justify-center gap-3 text-center">
      <p className="text-sm text-muted">
        Ask questions about this dashboard&rsquo;s panels and data. I can fetch
        fresh numbers with read-only queries.
      </p>
      <div className="flex flex-col gap-2">
        {EXAMPLE_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            onClick={() => onPick(prompt)}
            className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-left text-xs text-foreground transition-colors hover:border-primary"
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}

type ChatMessage = ReturnType<typeof useChat>["messages"][number];

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={cn("flex flex-col gap-1", isUser ? "items-end" : "items-start")}>
      {message.parts.map((part, i) => {
        if (part.type === "text") {
          if (!part.text) return null;
          return (
            <div
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
          return (
            <div
              key={i}
              className="flex items-center gap-1.5 text-xs text-muted"
            >
              {running ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Database className="h-3 w-3" />
              )}
              {running ? "Querying data…" : "Queried data"}
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}
