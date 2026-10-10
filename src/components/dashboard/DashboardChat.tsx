"use client";

import * as React from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import type { UIMessage } from "ai";
import {
  Database,
  ExternalLink,
  Maximize2,
  MessageSquare,
  Minimize2,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import type { Panel } from "@/lib/ir";
import { cn } from "@/lib/utils";
import { AiUnavailable } from "@/components/ai-unavailable";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { ErrorDisplay } from "@/components/ui/error-display";
import { WorkingStatus } from "@/components/composing";
import { CopyButton } from "@/components/settings/copy-button";
import { MarkdownView } from "@/components/panels/text";
import { useChatRequest } from "@/components/dashboard/chat-bridge";
import { type ApiError, apiErrorFromThrown } from "@/lib/errors";
import { chatHref, dashboardConversation } from "@/lib/chat/client";
import {
  type ChatCitation,
  chatViewFromSearch,
  citationsFromMessage,
  panelChatSuggestions,
} from "@/lib/chat-history";
import { browserStorage } from "@/lib/browser-storage";
import { readChatExpanded, writeChatExpanded } from "@/lib/chat-layout";
import { useShortcuts } from "@/lib/editor/use-shortcuts";
import { CHAT_OPEN_SHORTCUT } from "@/lib/shortcuts";
import {
  animateOut,
  DURATION_SLOW_MS,
  EASE_EMPHASIZED,
  flipFrom,
  isMotionActive,
} from "@/lib/motion";
import { useReducedMotion } from "@/components/motion-preference";

/**
 * What the chat needs to know about a panel: enough to cite it, to name it in
 * "Ask about this panel", and to suggest questions about it. All of it is
 * already client-visible, the same spec the grid renders.
 */
export type ChatPanel = Pick<Panel, "id" | "title" | "viz" | "query">;

/**
 * Floating, read-only chat scoped to one dashboard. It talks to
 * /api/dashboards/[id]/chat, which reasons over the dashboard's panels and may
 * run guarded read-only queries against the dashboard's sources. The widget
 * never mutates the dashboard.
 *
 * Each question carries what the reader has on screen (#366): the range and
 * variable picks, read from the URL `LiveDashboard` keeps, and the panel they
 * asked about, by id. The server checks and resolves all of it.
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
  aiUnavailable,
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
  /**
   * Why no model can answer on this server, or null. Decided on the server,
   * which is the only side with the env; the chat then says so instead of
   * sending a question that can only fail.
   */
  aiUnavailable: string | null;
}) {
  const [open, setOpen] = React.useState(false);
  const [input, setInput] = React.useState("");
  const [loadedHistory, setLoadedHistory] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  // The panel the reader asked about, by id; the server looks it up.
  const [about, setAbout] = React.useState<string | null>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const launcherRef = React.useRef<HTMLElement>(null);
  const returnFocus = React.useRef(false);
  const firstBox = React.useRef<DOMRect | null>(null);
  const reduced = useReducedMotion();

  // The transport reads this when it sends, so it is a ref, not state.
  const aboutRef = React.useRef(about);
  React.useEffect(() => {
    aboutRef.current = about;
  }, [about]);

  const [transport] = React.useState(
    () =>
      new DefaultChatTransport({
        api: `/api/dashboards/${dashboardId}/chat`,
        // Read at send time, so the answer is about what is on screen now.
        body: () => ({
          ...chatViewFromSearch(window.location.search),
          ...(aboutRef.current ? { panelId: aboutRef.current } : {}),
        }),
      }),
  );
  const { messages, sendMessage, setMessages, status, stop, error, regenerate } = useChat(
    { transport },
  );

  const busy = status === "submitted" || status === "streaming";
  const [openingInChat, setOpeningInChat] = React.useState(false);
  const [openError, setOpenError] = React.useState<ApiError | null>(null);

  /**
   * Continue on the Chat page (#416): this dashboard's conversation, made on
   * first use, with the panels in context and the range on screen.
   */
  async function openInChat() {
    setOpeningInChat(true);
    setOpenError(null);
    const made = await dashboardConversation(
      dashboardId,
      chatViewFromSearch(window.location.search).timeRange,
    );
    setOpeningInChat(false);
    if (made.ok) window.location.assign(chatHref(made.value));
    else setOpenError(made.error);
  }
  const listRef = React.useRef<HTMLDivElement>(null);
  const aboutPanel = panels.find((p) => p.id === about);

  React.useEffect(() => setExpanded(readChatExpanded(browserStorage())), []);

  useShortcuts([{ ...CHAT_OPEN_SHORTCUT, run: () => setOpen(true), disabled: open }]);

  // "Ask about this panel" from a panel's menu: open on it.
  const request = useChatRequest();
  React.useEffect(() => {
    if (!request) return;
    setAbout(request.panelId);
    setOpen(true);
    inputRef.current?.focus();
  }, [request]);

  // Focus the message box on open, and give focus back to the launcher when
  // the chat closes from inside it.
  React.useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    } else if (returnFocus.current) {
      returnFocus.current = false;
      launcherRef.current?.focus();
    }
  }, [open]);

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

  // The size change is a FLIP of the box itself, like a panel's fullscreen:
  // measured before the class swap, played after it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate re-run trigger, not a read
  React.useLayoutEffect(() => {
    const el = panelRef.current;
    const from = firstBox.current;
    firstBox.current = null;
    if (!el || !from || reduced || typeof el.animate !== "function") return;
    const keyframe = flipFrom(from, el.getBoundingClientRect());
    if (!keyframe) return;
    el.animate(
      [
        { ...keyframe, transformOrigin: "0 0" },
        { translate: "0 0", scale: "1 1", transformOrigin: "0 0" },
      ],
      { duration: DURATION_SLOW_MS, easing: EASE_EMPHASIZED },
    );
  }, [expanded, reduced]);

  function toggleExpanded() {
    firstBox.current = panelRef.current?.getBoundingClientRect() ?? null;
    const next = !expanded;
    setExpanded(next);
    writeChatExpanded(browserStorage(), next);
  }

  async function clear() {
    setMessages([]);
    setInput("");
    setAbout(null);
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
      // Smooth only between turns: a smooth scroll restarted on every
      // streamed token lags behind the text. The reduce rule forces CSS
      // `scroll-behavior: auto`, but a JS scroll's option bypasses it.
      listRef.current?.scrollTo({
        top: listRef.current.scrollHeight,
        behavior: isMotionActive() && status !== "streaming" ? "smooth" : "auto",
      });
    }
  }, [messages, status, open]);

  function ask(text: string) {
    if (!text.trim() || busy || aiUnavailable) return;
    // Fire and forget: useChat surfaces a failed send through `error`, which is
    // rendered below, so awaiting the promise here would handle it twice.
    void sendMessage({ text: text.trim() });
  }

  function submit() {
    if (!input.trim() || busy) return;
    ask(input);
    setInput("");
  }

  // The panel and the button are two render branches, so the exit has to
  // play before `open` flips (#235); the entrance is `@starting-style` below.
  async function close() {
    returnFocus.current = panelRef.current?.contains(document.activeElement) ?? false;
    if (panelRef.current) await animateOut(panelRef.current, !reduced);
    setOpen(false);
  }

  if (!open) {
    return (
      <Button
        ref={launcherRef}
        variant="primary"
        size="icon"
        aria-label="Ask about this dashboard"
        aria-keyshortcuts={CHAT_OPEN_SHORTCUT.key}
        title={`Ask about this dashboard (${CHAT_OPEN_SHORTCUT.key.toUpperCase()})`}
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-50 h-12 w-12 rounded-full shadow-lg transition-[opacity,scale,background-color,color,border-color] duration-(--duration-base) ease-emphasized starting:scale-75 starting:opacity-0"
      >
        <MessageSquare className="h-5 w-5" />
      </Button>
    );
  }

  const shownSuggestions = aboutPanel ? panelChatSuggestions(aboutPanel) : suggestions;
  const last = messages[messages.length - 1];

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Dashboard chat"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        // A fullscreen panel underneath listens for Escape too; this one is ours.
        e.stopPropagation();
        void close();
      }}
      className={cn(
        "fixed right-6 z-50 flex max-w-[calc(100vw-3rem)] flex-col overflow-hidden border border-border bg-surface shadow-lg transition-[opacity,translate] duration-(--duration-base) ease-emphasized starting:translate-y-3 starting:opacity-0",
        expanded
          ? "top-20 bottom-6 w-[40rem]"
          : "bottom-6 h-[560px] max-h-[calc(100vh-3rem)] w-[380px]",
      )}
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
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open in Explore"
            title="Open in Explore: continue this conversation on its own page"
            disabled={busy || openingInChat}
            onClick={() => void openInChat()}
          >
            <ExternalLink className="h-4 w-4" />
          </Button>
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
            aria-label={expanded ? "Shrink chat" : "Expand chat"}
            title={expanded ? "Shrink chat" : "Expand chat"}
            aria-pressed={expanded}
            onClick={toggleExpanded}
          >
            {expanded ? (
              <Minimize2 className="h-4 w-4" />
            ) : (
              <Maximize2 className="h-4 w-4" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close chat"
            title="Close chat (Esc)"
            onClick={() => void close()}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-3">
        {messages.length === 0 ? (
          // Suggestions start a conversation; once one has started, the
          // conversation is the thing to read, so they are not offered again
          // until it is cleared.
          <EmptyState
            panelTitle={aboutPanel?.title}
            suggestions={shownSuggestions}
            onPick={ask}
          />
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                panels={panels}
                streaming={busy && message === last}
                onRetry={
                  !busy && message === last && message.role === "assistant"
                    ? () => void regenerate()
                    : undefined
                }
              />
            ))}
            {status === "submitted" && <WorkingStatus>Thinking…</WorkingStatus>}
          </div>
        )}

        {error && (
          <ErrorDisplay
            error={apiErrorFromThrown(error)}
            className="mt-3"
            onRetry={() => regenerate()}
          />
        )}
        {openError && (
          <ErrorDisplay
            error={openError}
            className="mt-3"
            onRetry={() => void openInChat()}
            retryLabel="Try again"
          />
        )}
      </div>

      <div className="border-t border-border p-3">
        {aiUnavailable && <AiUnavailable message={aiUnavailable} className="mb-2" />}
        {aboutPanel && (
          <div className="mb-2 flex">
            <span className="inline-flex min-w-0 items-center gap-1 border border-border bg-surface-2 py-0.5 pl-2 pr-0.5 text-xs">
              <span className="truncate">
                <span className="text-muted">About </span>
                {aboutPanel.title}
              </span>
              <button
                type="button"
                aria-label={`Stop asking about ${aboutPanel.title}`}
                title="Ask about the whole dashboard"
                onClick={() => {
                  setAbout(null);
                  inputRef.current?.focus();
                }}
                className="p-0.5 text-muted transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          </div>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            ref={inputRef}
            value={input}
            disabled={aiUnavailable !== null}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            // A placeholder disappears once typing starts; a name does not (#77).
            aria-label="Message"
            placeholder={
              aboutPanel ? "Ask about this panel…" : "Ask about this dashboard…"
            }
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
  panelTitle,
  suggestions,
  onPick,
}: {
  panelTitle?: string;
  suggestions: string[];
  onPick: (text: string) => void;
}) {
  return (
    <div className="flex h-full flex-col justify-center gap-3 text-center">
      <p className="text-sm text-muted">
        {panelTitle ? (
          <>
            Ask about <span className="text-foreground">{panelTitle}</span>, over the time
            range and filters on screen. I can fetch fresh numbers with read-only queries.
          </>
        ) : (
          <>
            Ask questions about this dashboard&rsquo;s panels and data, over the time
            range and filters on screen. I can fetch fresh numbers with read-only queries.
          </>
        )}
      </p>
      <Suggestions suggestions={suggestions} onPick={onPick} />
    </div>
  );
}

/**
 * Questions to start with. Derived from the spec — no second model call, so
 * they cost nothing and are the same every time for the same dashboard.
 * Shown on an empty chat only.
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
      {suggestions.map((prompt, i) => (
        <button
          key={prompt}
          type="button"
          onClick={() => onPick(prompt)}
          className="stagger-in border border-border bg-surface-2 px-3 py-2 text-left text-xs text-foreground transition-colors hover:border-primary focus-visible:outline-2 focus-visible:outline-primary"
          style={{ "--i": i } as React.CSSProperties}
        >
          {prompt}
        </button>
      ))}
    </fieldset>
  );
}

type ChatMessage = ReturnType<typeof useChat>["messages"][number];

/** The answer's words, for Copy: its text parts, in order. */
function answerText(message: ChatMessage): string {
  return message.parts
    .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
    .join("\n\n");
}

function MessageBubble({
  message,
  panels,
  streaming,
  onRetry,
}: {
  message: ChatMessage;
  panels: ChatPanel[];
  /** This message is still being written. */
  streaming: boolean;
  /** Ask for this answer again; only the last answer offers it. */
  onRetry?: () => void;
}) {
  const isUser = message.role === "user";
  const citations = isUser ? [] : citationsFromMessage(message, panels);
  const text = isUser ? "" : answerText(message);

  return (
    // No `--i`: a message rises in when it arrives, and the latest one must
    // not wait behind the ones already there.
    <div
      className={cn(
        "stagger-in flex flex-col gap-1",
        isUser ? "items-end" : "items-start",
      )}
    >
      {message.parts.map((part, i) => {
        if (part.type === "text") {
          if (!part.text) return null;
          return isUser ? (
            // Parts are append-only within a message and never reordered.
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only stream parts
              key={i}
              className="max-w-[85%] whitespace-pre-wrap bg-primary px-3 py-2 text-sm text-primary-foreground"
            >
              {part.text}
            </div>
          ) : (
            // The model's words, through the same sanitized Markdown subset a
            // text panel uses: React elements, never an HTML string.
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only stream parts
              key={i}
              className="min-w-0 max-w-[92%] bg-surface-2 px-3 py-2 text-foreground"
            >
              <MarkdownView source={part.text} />
            </div>
          );
        }
        if (part.type === "tool-runQuery") {
          const running =
            part.state === "input-streaming" || part.state === "input-available";
          if (!running) return null;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only stream parts
            <WorkingStatus key={i} className="text-xs">
              Querying data…
            </WorkingStatus>
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
      {!isUser && text && !streaming && (
        <div className="flex items-center gap-1">
          <CopyButton value={text} label="Copy answer" />
          {onRetry && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label="Try again"
              title="Try again"
              onClick={onRetry}
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** `host = a, b · region = eu`, or nothing when no variable was bound. */
function variablesSummary(variables: ChatCitation["variables"]): string {
  return Object.entries(variables ?? {})
    .map(([name, values]) => `${name} = ${values.join(", ") || "(none)"}`)
    .join(" · ");
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
  const values = variablesSummary(citation.variables);
  return (
    <details className="max-w-[85%] border border-border bg-surface-2/60 text-xs">
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
        {citation.timeRange ? (
          <p className="text-muted">
            The server narrowed it to{" "}
            <span className="font-mono text-foreground">
              {citation.timeRange.from} → {citation.timeRange.to}
            </span>
            {values && (
              <>
                {" "}
                with <span className="font-mono text-foreground">{values}</span>
              </>
            )}
            .
          </p>
        ) : (
          <p className="text-muted">
            The dashboard time range was applied by the server on top of this statement.
          </p>
        )}
      </div>
    </details>
  );
}
