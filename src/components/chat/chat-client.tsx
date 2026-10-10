"use client";

import * as React from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { Clock, Database, Plus, SendHorizontal, Square } from "lucide-react";
import type { EffectiveModel } from "@/lib/ai/model-config";
import { AiUnavailable } from "@/components/ai-unavailable";
import { WorkingStatus } from "@/components/composing";
import { COMPOSER_CHIP_CLASS, SourceChipLabel } from "@/components/composer-chip";
import { NoSources } from "@/components/onboarding/no-sources";
import { MarkdownView } from "@/components/panels/text";
import {
  CatalogHealthNotice,
  useCatalogRefresh,
} from "@/components/sources/catalog-health";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { ErrorDisplay } from "@/components/ui/error-display";
import { Textarea } from "@/components/ui/input";
import {
  Menu,
  MenuCheckboxItem,
  MenuRadioGroup,
  MenuRadioItem,
} from "@/components/ui/menu";
import { PageHeader } from "@/components/ui/page-header";
import { createConversation, updateConversation } from "@/lib/chat/client";
import type { ChatSourceOption } from "@/lib/chat/page-data";
import { SHOW_PANEL_PART } from "@/lib/chat/panel";
import { type ApiError, apiErrorFromThrown } from "@/lib/errors";
import { EXPLORE_TIME_RANGES, timeRangeLabel } from "@/lib/explore-defaults";
import type { TimeRange } from "@/lib/ir";
import { cn } from "@/lib/utils";
import { ChatPanelCard, type ShowPanelPart } from "./chat-panel-card";

/** The most sources one conversation may use, as the server holds it. */
const MAX_SOURCES = 3;

const HEADER_CHIP_CLASS =
  "h-8 w-auto gap-1.5 border border-border bg-surface px-2.5 text-sm text-foreground";

export interface InitialConversation {
  conversation: {
    id: string;
    title: string;
    workspaceId: string;
    sourceIds: string[];
    timeRange: TimeRange;
  };
  messages: UIMessage[];
  unavailableSourceIds: string[];
}

/**
 * Chat (#416): a conversation with your data. The answer streams as prose,
 * with inline panels the server drew through the guard; the conversation is
 * stored per person, so it has a URL and survives a reload.
 *
 * The page sends only the new question: the history the model sees is the
 * stored conversation, and a drawn panel runs again through the run route,
 * which reads its spec from the store. Nothing here carries a statement.
 */
export function ChatClient({
  sources,
  models,
  canManageSources,
  defaultFrom,
  initial,
}: {
  sources: ChatSourceOption[];
  models: Record<string, EffectiveModel>;
  canManageSources: boolean;
  defaultFrom: string;
  initial?: InitialConversation;
}) {
  const [conversationId, setConversationId] = React.useState<string | null>(
    initial?.conversation.id ?? null,
  );
  const idRef = React.useRef(conversationId);
  const [selected, setSelected] = React.useState<string[]>(() => {
    if (initial) return initial.conversation.sourceIds;
    const first = sources.find((s) => !s.catalog.blocked) ?? sources[0];
    return first ? [first.id] : [];
  });
  const [timeRange, setTimeRange] = React.useState<TimeRange>(
    initial?.conversation.timeRange ?? { from: defaultFrom, to: "now" },
  );
  const [text, setText] = React.useState("");
  const [setupError, setSetupError] = React.useState<ApiError | null>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const catalog = useCatalogRefresh(
    Object.fromEntries(sources.map((s) => [s.id, s.catalog])),
  );

  const chosen = sources.filter((s) => selected.includes(s.id));
  const workspaceId = initial?.conversation.workspaceId ?? chosen[0]?.workspaceId;
  const effective = workspaceId ? models[workspaceId] : undefined;
  const aiUnavailable = effective?.unavailable ?? null;
  const unavailable = initial?.unavailableSourceIds ?? [];
  const readOnly =
    initial !== undefined &&
    initial.conversation.sourceIds.every((id) => unavailable.includes(id));

  const [transport] = React.useState(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        // The new question only, to this conversation's turn route: the
        // server reads the history from the store.
        prepareSendMessagesRequest: ({ messages }) => ({
          api: `/api/chat/${idRef.current}/messages`,
          body: { message: messages.at(-1) },
        }),
      }),
  );
  const { messages, sendMessage, status, stop, error } = useChat({
    transport,
    messages: initial?.messages,
  });
  const busy = status === "submitted" || status === "streaming";

  // Focus lands in the composer, where the next thing to do is.
  React.useEffect(() => inputRef.current?.focus(), []);

  // Keep the newest message in view as it streams.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the conversation grows
  React.useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages, status]);

  async function ask(question: string) {
    const trimmed = question.trim();
    if (!trimmed || busy || readOnly) return;
    setSetupError(null);
    if (!idRef.current) {
      const made = await createConversation({ sourceIds: selected, timeRange });
      if (!made.ok) {
        setSetupError(made.error);
        return;
      }
      idRef.current = made.value;
      setConversationId(made.value);
      // The conversation has a URL now; no navigation, no reload.
      window.history.replaceState(null, "", `/chat/${made.value}`);
    }
    setText("");
    // A failed send surfaces through `error`.
    void sendMessage({ text: trimmed });
  }

  async function changeRange(from: string) {
    const next = { from, to: "now" };
    setTimeRange(next);
    if (!idRef.current) return;
    const saved = await updateConversation(idRef.current, { timeRange: next });
    if (!saved.ok) setSetupError(saved.error);
  }

  async function toggleSource(id: string, on: boolean) {
    const source = sources.find((s) => s.id === id);
    if (!source) return;
    let next: string[];
    if (!on) next = selected.filter((s) => s !== id);
    else if (source.workspaceId !== workspaceId) next = [id];
    else next = [...selected, id].slice(0, MAX_SOURCES);
    if (next.length === 0) return;
    setSelected(next);
    if (!idRef.current) return;
    const saved = await updateConversation(idRef.current, { sourceIds: next });
    if (!saved.ok) {
      setSetupError(saved.error);
      setSelected(selected);
    }
  }

  const header = (
    <PageHeader
      title={initial?.conversation.title || "Chat"}
      badge={effective?.model && <Badge title="Model">{effective.model}</Badge>}
      description="Ask about your data in plain English. Answers come back in words, with charts and tables the server ran for you."
      actions={
        <>
          <Menu
            label={`Time range: ${timeRangeLabel(timeRange.from)}`}
            className={HEADER_CHIP_CLASS}
            trigger={
              <>
                <Clock className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
                <span className="truncate">{timeRangeLabel(timeRange.from)}</span>
              </>
            }
          >
            <MenuRadioGroup
              label="Time range"
              value={timeRange.from}
              onValueChange={(v) => void changeRange(v)}
            >
              {EXPLORE_TIME_RANGES.map((p) => (
                <MenuRadioItem key={p.value} value={p.value}>
                  {p.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </Menu>
          {conversationId && (
            <ButtonLink
              href="/chat"
              variant="secondary"
              size="sm"
              className="h-8 gap-1.5"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              New
            </ButtonLink>
          )}
        </>
      }
    />
  );

  if (sources.length === 0) {
    return (
      <div className="w-full space-y-6">
        {header}
        <NoSources canManageSources={canManageSources} />
      </div>
    );
  }

  const starters = chosen[0]?.starters ?? [];
  const primary = chosen[0];

  return (
    <div className="flex w-full flex-1 flex-col gap-4">
      {header}

      <div
        ref={listRef}
        role="log"
        aria-live="polite"
        aria-busy={busy}
        aria-label="Conversation"
        className="flex min-h-80 flex-1 flex-col gap-4"
      >
        {messages.length === 0 && (
          <EmptyConversation
            starters={starters}
            disabled={aiUnavailable !== null}
            onPick={(s) => {
              setText(s);
              inputRef.current?.focus();
            }}
          />
        )}
        {messages.map((message) => (
          <Message
            key={message.id}
            message={message}
            conversationId={conversationId}
            timeRange={timeRange}
          />
        ))}
        {status === "submitted" && <WorkingStatus>Thinking…</WorkingStatus>}
      </div>

      <div className="sticky bottom-0 space-y-2 border-t border-border bg-background pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {unavailable.length > 0 && (
          <p className="text-sm text-muted">
            {readOnly
              ? "None of this conversation's sources is available to you any more. It is read-only."
              : `Not available to you any more: ${unavailable.join(", ")}.`}
          </p>
        )}
        {primary && (
          <CatalogHealthNotice
            source={primary}
            health={catalog.health[primary.id]}
            canRefresh={primary.canRefresh}
            onRefreshed={(health) => catalog.update(primary.id, health)}
          />
        )}
        {aiUnavailable && <AiUnavailable message={aiUnavailable} />}
        {(setupError || error) && (
          <ErrorDisplay
            error={setupError ?? apiErrorFromThrown(error)}
            onRetry={() => setSetupError(null)}
            retryLabel="Dismiss"
          />
        )}
        <form
          aria-label="Ask"
          className="flex flex-wrap items-end gap-2 sm:flex-nowrap"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(text);
          }}
        >
          <Menu
            label={`Sources: ${chosen.map((s) => s.name).join(", ") || "none"}`}
            className={COMPOSER_CHIP_CLASS}
            panelClassName="max-w-sm"
            trigger={
              primary ? (
                <SourceChipLabel
                  name={primary.name}
                  workspaceId={primary.workspaceId}
                  extra={chosen.length - 1}
                />
              ) : (
                <>
                  <Database className="h-3.5 w-3.5 text-muted" aria-hidden />
                  <span>Pick a source</span>
                </>
              )
            }
          >
            {sources.map((s) => {
              // A conversation stays in its workspace; another one is a new conversation.
              const otherWorkspace =
                conversationId !== null && s.workspaceId !== workspaceId;
              const full = !selected.includes(s.id) && selected.length >= MAX_SOURCES;
              return (
                <MenuCheckboxItem
                  key={s.id}
                  checked={selected.includes(s.id)}
                  disabled={
                    otherWorkspace || (full && s.workspaceId === workspaceId) || busy
                  }
                  onCheckedChange={(on) => void toggleSource(s.id, on)}
                >
                  <span className="truncate">{s.name}</span>
                  <span className="text-xs text-muted">{s.workspaceId}</span>
                </MenuCheckboxItem>
              );
            })}
          </Menu>
          <label htmlFor="chat-message" className="sr-only">
            Message
          </label>
          <div className="relative min-w-0 flex-1 basis-full sm:basis-auto">
            <Textarea
              id="chat-message"
              ref={inputRef}
              rows={1}
              value={text}
              disabled={aiUnavailable !== null || readOnly}
              placeholder={
                starters[0] ? `e.g. ${starters[0]}` : "Ask a question about these sources"
              }
              className="max-h-48 min-h-10 resize-none pr-12"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends, Shift+Enter breaks the line, as the dashboard chat.
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void ask(text);
                }
                if (e.key === "Escape" && busy) void stop();
              }}
            />
            {busy ? (
              <Button
                type="button"
                size="icon"
                variant="secondary"
                onClick={() => void stop()}
                aria-label="Stop"
                title="Stop"
                className="absolute right-1 bottom-1 h-8 w-8"
              >
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon"
                disabled={
                  !text.trim() ||
                  aiUnavailable !== null ||
                  readOnly ||
                  selected.length === 0
                }
                aria-label="Send"
                title="Send"
                className="absolute right-1 bottom-1 h-8 w-8"
              >
                <SendHorizontal className="h-4 w-4" />
              </Button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

function EmptyConversation({
  starters,
  disabled,
  onPick,
}: {
  starters: string[];
  disabled: boolean;
  onPick: (starter: string) => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 border border-dashed border-border p-8 text-center text-sm text-muted">
      <p>
        Ask a question. Ask to chart or compare something to get a panel in the answer.
      </p>
      {starters.length > 0 && (
        <div className="flex flex-wrap justify-center gap-2">
          {starters.slice(0, 3).map((s) => (
            <button
              key={s}
              type="button"
              disabled={disabled}
              onClick={() => onPick(s)}
              className="border border-border bg-surface px-3 py-1 text-left text-xs text-muted transition-colors hover:border-primary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Message({
  message,
  conversationId,
  timeRange,
}: {
  message: UIMessage;
  conversationId: string | null;
  timeRange: TimeRange;
}) {
  const isUser = message.role === "user";
  return (
    // No `--i`: a message rises in when it arrives, and the newest must not
    // wait behind the others.
    <div
      className={cn(
        "stagger-in flex flex-col gap-2",
        isUser ? "items-end" : "items-stretch",
      )}
    >
      {message.parts.map((part, i) => {
        // Parts are append-only within a message and never reordered.
        const key = `${message.id}:${i}`;
        if (part.type === "text") {
          if (!part.text) return null;
          return isUser ? (
            <div
              key={key}
              className="max-w-[85%] whitespace-pre-wrap bg-primary px-3 py-2 text-sm text-primary-foreground"
            >
              {part.text}
            </div>
          ) : (
            <div key={key} className="min-w-0 text-foreground">
              <MarkdownView source={part.text} />
            </div>
          );
        }
        if (part.type === "tool-runQuery") {
          return <QueryCitation key={key} part={part as unknown as ToolPart} />;
        }
        if (part.type === SHOW_PANEL_PART) {
          return (
            <ChatPanelCard
              key={key}
              conversationId={conversationId}
              part={part as unknown as ShowPanelPart}
              timeRange={timeRange}
              refreshKey={0}
            />
          );
        }
        return null;
      })}
    </div>
  );
}

interface ToolPart {
  state: string;
  input?: { sourceId?: string; sql?: string; promql?: string };
}

/** A `runQuery` the answer rests on: running, then "Ran this query". */
function QueryCitation({ part }: { part: ToolPart }) {
  if (part.state === "input-streaming" || part.state === "input-available") {
    return <WorkingStatus className="text-xs">Querying data…</WorkingStatus>;
  }
  const statement = part.input?.sql ?? part.input?.promql;
  if (!statement) return null;
  return (
    <details className="max-w-[85%] border border-border bg-surface-2/60 text-xs">
      <summary className="flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-muted hover:text-foreground">
        <Database className="h-3 w-3 shrink-0" aria-hidden />
        Ran this query
      </summary>
      <div className="space-y-2 border-t border-border px-2.5 py-2">
        <p className="text-muted">
          Source <span className="font-mono text-foreground">{part.input?.sourceId}</span>
        </p>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
          {statement}
        </pre>
        <p className="text-muted">
          The server applied the conversation&rsquo;s time range on top of it.
        </p>
      </div>
    </details>
  );
}
