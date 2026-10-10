"use client";

import * as React from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { Database, PanelLeft, Plus, SendHorizontal, Square } from "lucide-react";
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
import { Dialog } from "@/components/ui/dialog";
import { ErrorDisplay } from "@/components/ui/error-display";
import { Textarea } from "@/components/ui/input";
import { Menu, MenuCheckboxItem } from "@/components/ui/menu";
import { PageHeader } from "@/components/ui/page-header";
import { PromptHistoryMenu, usePromptHistory } from "@/components/prompt-history";
import { browserStorage } from "@/lib/browser-storage";
import { readChatPanelOpen, writeChatPanelOpen } from "@/lib/chat-layout";
import {
  createConversation,
  savePreferences,
  updateConversation,
} from "@/lib/chat/client";
import type { ChatSourceOption } from "@/lib/chat/page-data";
import { SHOW_PANEL_PART } from "@/lib/chat/panel";
import { persistableMessage } from "@/lib/chat/persist";
import { useShortcuts } from "@/lib/editor/use-shortcuts";
import { type ApiError, apiErrorFromThrown } from "@/lib/errors";
import { timeRangeLabel } from "@/lib/chat/defaults";
import type { TimeRange } from "@/lib/ir";
import type { ChatPreferences } from "@/lib/preferences";
import { CHAT_PANEL_SHORTCUT } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { type AddTo, ChatPanelCard, type ShowPanelPart } from "./chat-panel-card";
import { ChatSidePanel } from "./chat-side-panel";

/** The most sources one conversation may use, as the server holds it. */
const MAX_SOURCES = 3;

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

/** Whether the viewport is at least `md`, where the side panel is an `aside`. */
function useWide(): boolean {
  const [wide, setWide] = React.useState(true);
  React.useEffect(() => {
    const query = window.matchMedia("(min-width: 768px)");
    const update = () => setWide(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return wide;
}

/**
 * Chat (#416): a conversation with your data. The answer streams as prose,
 * with inline panels the server drew through the guard. Beside it, the side
 * panel: the sources, this person's past conversations, and the settings.
 *
 * A kept conversation has a URL and survives a reload: the page sends only
 * the new question, the history the model sees is the stored one, and a
 * drawn panel runs again through the run route. With Keep my conversations
 * off nothing is stored: the page sends the history it holds, each panel
 * reduced to its sample, and a panel cannot be re-run once drawn. Nothing
 * here ever carries a statement to run.
 */
export function ChatClient({
  sources,
  models,
  canManageSources,
  defaultFrom,
  chatPrefs,
  addableWorkspaces,
  defaultRefreshIntervalMs,
  initial,
}: {
  sources: ChatSourceOption[];
  models: Record<string, EffectiveModel>;
  canManageSources: boolean;
  defaultFrom: string;
  chatPrefs: ChatPreferences;
  addableWorkspaces: string[];
  defaultRefreshIntervalMs: number;
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
  const [prefs, setPrefs] = React.useState(chatPrefs);
  const [text, setText] = React.useState("");
  const [setupError, setSetupError] = React.useState<ApiError | null>(null);
  const [panelOpen, setPanelOpen] = React.useState(true);
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [historyKey, setHistoryKey] = React.useState(0);
  const wide = useWide();
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const catalog = useCatalogRefresh(
    Object.fromEntries(sources.map((s) => [s.id, s.catalog])),
  );

  const chosen = sources.filter((s) => selected.includes(s.id));
  const workspaceId = initial?.conversation.workspaceId ?? chosen[0]?.workspaceId;
  const effective = workspaceId ? models[workspaceId] : undefined;
  const aiUnavailable = effective?.unavailable ?? null;
  // Recent questions in this workspace, when this person keeps them (#83).
  const prompts = usePromptHistory(workspaceId, "chat");
  const unavailable = initial?.unavailableSourceIds ?? [];
  const readOnly =
    initial !== undefined &&
    initial.conversation.sourceIds.every((id) => unavailable.includes(id));

  // What the transport reads when it sends, so these are refs, not state.
  const sendRef = React.useRef({ selected, timeRange });
  React.useEffect(() => {
    sendRef.current = { selected, timeRange };
  }, [selected, timeRange]);

  const [transport] = React.useState(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        prepareSendMessagesRequest: ({ messages }) =>
          idRef.current
            ? // A kept conversation: the new question only; the server reads
              // the history from the store.
              {
                api: `/api/chat/${idRef.current}/messages`,
                body: { message: messages.at(-1) },
              }
            : // Not kept: the history this page holds, each drawn panel
              // reduced to its sample before it leaves.
              {
                api: "/api/chat/turn",
                body: {
                  sourceIds: sendRef.current.selected,
                  timeRange: sendRef.current.timeRange,
                  history: messages.slice(0, -1).map(persistableMessage),
                  message: messages.at(-1),
                },
              },
      }),
  );
  const { messages, sendMessage, status, stop, error } = useChat({
    transport,
    messages: initial?.messages,
  });
  const busy = status === "submitted" || status === "streaming";

  React.useEffect(() => setPanelOpen(readChatPanelOpen(browserStorage())), []);

  // Focus lands in the composer, where the next thing to do is.
  React.useEffect(() => inputRef.current?.focus(), []);

  // Keep the newest message in view as it streams.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the conversation grows
  React.useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages, status]);

  // A finished answer moves this conversation to the top of History.
  const wasBusy = React.useRef(false);
  React.useEffect(() => {
    if (wasBusy.current && !busy) setHistoryKey((k) => k + 1);
    wasBusy.current = busy;
  }, [busy]);

  // Live refresh: re-run the panels on screen, quietly, skipping a hidden tab.
  React.useEffect(() => {
    if (prefs.refreshMs <= 0 || !conversationId) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") setRefreshKey((k) => k + 1);
    }, prefs.refreshMs);
    return () => clearInterval(timer);
  }, [prefs.refreshMs, conversationId]);

  function togglePanel() {
    if (!wide) {
      setSheetOpen((o) => !o);
      return;
    }
    setPanelOpen((open) => {
      writeChatPanelOpen(browserStorage(), !open);
      return !open;
    });
  }
  useShortcuts([{ ...CHAT_PANEL_SHORTCUT, run: togglePanel }]);

  async function ask(question: string) {
    const trimmed = question.trim();
    if (!trimmed || busy || readOnly) return;
    setSetupError(null);
    if (!idRef.current && prefs.remember) {
      const made = await createConversation({ sourceIds: selected, timeRange });
      if (!made.ok) {
        setSetupError(made.error);
        return;
      }
      idRef.current = made.value;
      setConversationId(made.value);
      setHistoryKey((k) => k + 1);
      // The conversation has a URL now; no navigation, no reload.
      window.history.replaceState(null, "", `/chat/${made.value}`);
    }
    setText("");
    prompts.remember(trimmed);
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

  async function changePrefs(patch: Partial<ChatPreferences>) {
    const previous = prefs;
    setPrefs({ ...prefs, ...patch });
    const saved = await savePreferences({
      ...(patch.refreshMs !== undefined ? { chatRefreshMs: patch.refreshMs } : {}),
      ...(patch.showQueries !== undefined ? { chatShowQueries: patch.showQueries } : {}),
      ...(patch.remember !== undefined ? { rememberChats: patch.remember } : {}),
    });
    if (!saved.ok) {
      setPrefs(previous);
      setSetupError(saved.error);
      return;
    }
    // The server deleted every kept conversation: start again, unkept.
    if (patch.remember === false) window.location.assign("/chat");
  }

  const panel = (
    <ChatSidePanel
      sources={sources}
      selected={selected}
      workspaceId={workspaceId}
      conversationId={conversationId}
      busy={busy}
      onToggleSource={(id, on) => void toggleSource(id, on)}
      timeRange={timeRange.from}
      onTimeRange={(from) => void changeRange(from)}
      prefs={prefs}
      onPrefs={(patch) => void changePrefs(patch)}
      historyKey={historyKey}
    />
  );

  const header = (
    <PageHeader
      title={initial?.conversation.title || "Chat"}
      badge={effective?.model && <Badge title="Model">{effective.model}</Badge>}
      description="Ask about your data in plain English. Answers come back in words, with charts and tables the server ran for you."
      actions={
        <>
          <Button
            variant="secondary"
            size="sm"
            className="h-8 gap-1.5"
            aria-expanded={wide ? panelOpen : sheetOpen}
            aria-controls={wide ? "chat-side-panel" : undefined}
            onClick={togglePanel}
            title={`Show or hide the side panel (${CHAT_PANEL_SHORTCUT.key})`}
          >
            <PanelLeft className="h-3.5 w-3.5" aria-hidden />
            <span className="md:hidden">
              {chosen.length} {chosen.length === 1 ? "source" : "sources"} ·{" "}
              {timeRangeLabel(timeRange.from)}
            </span>
            <span className="max-md:hidden">Side panel</span>
          </Button>
          <PromptHistoryMenu
            history={prompts}
            disabled={busy}
            onPick={(prompt) => {
              setText(prompt);
              inputRef.current?.focus();
            }}
          />
          {(conversationId || messages.length > 0) && (
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
        className={cn(
          "grid min-h-0 flex-1 grid-cols-1 gap-6",
          wide && panelOpen && "md:grid-cols-[16rem_minmax(0,1fr)]",
        )}
      >
        {wide && panelOpen && (
          <aside
            id="chat-side-panel"
            aria-label="Conversation"
            className="fade-in self-start border-r border-border pr-4 md:sticky md:top-4 md:max-h-[calc(100vh-6rem)] md:overflow-y-auto"
          >
            {panel}
          </aside>
        )}
        {!wide && (
          <Dialog open={sheetOpen} onOpenChange={setSheetOpen} title="Conversation">
            {panel}
          </Dialog>
        )}

        <div className="flex min-w-0 flex-col gap-4">
          <div
            ref={listRef}
            role="log"
            aria-live="polite"
            aria-busy={busy}
            aria-label="Messages"
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
                refreshKey={refreshKey}
                showQueries={prefs.showQueries}
                addTo={
                  workspaceId && addableWorkspaces.includes(workspaceId)
                    ? {
                        workspaceId,
                        timeRange,
                        refreshIntervalMs: defaultRefreshIntervalMs,
                      }
                    : undefined
                }
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
                className={cn(COMPOSER_CHIP_CLASS, "max-sm:aspect-square max-sm:px-0")}
                panelClassName="max-w-sm"
                trigger={
                  primary ? (
                    <span className="flex min-w-0 items-center gap-1.5 max-sm:[&>*:not(svg)]:sr-only">
                      <SourceChipLabel
                        name={primary.name}
                        workspaceId={primary.workspaceId}
                        extra={chosen.length - 1}
                      />
                    </span>
                  ) : (
                    <>
                      <Database className="h-3.5 w-3.5 text-muted" aria-hidden />
                      <span className="max-sm:sr-only">Pick a source</span>
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
              <div className="relative min-w-0 flex-1 basis-0">
                <Textarea
                  id="chat-message"
                  ref={inputRef}
                  rows={1}
                  value={text}
                  disabled={aiUnavailable !== null || readOnly}
                  placeholder={
                    starters[0]
                      ? `e.g. ${starters[0]}`
                      : "Ask a question about these sources"
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
  refreshKey,
  showQueries,
  addTo,
}: {
  message: UIMessage;
  addTo?: AddTo;
  conversationId: string | null;
  timeRange: TimeRange;
  refreshKey: number;
  showQueries: boolean;
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
          return (
            <QueryCitation
              key={key}
              part={part as unknown as ToolPart}
              open={showQueries}
            />
          );
        }
        if (part.type === SHOW_PANEL_PART) {
          return (
            <ChatPanelCard
              key={key}
              conversationId={conversationId}
              part={part as unknown as ShowPanelPart}
              timeRange={timeRange}
              refreshKey={refreshKey}
              showQuery={showQueries}
              addTo={addTo}
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
function QueryCitation({ part, open }: { part: ToolPart; open: boolean }) {
  if (part.state === "input-streaming" || part.state === "input-available") {
    return <WorkingStatus className="text-xs">Querying data…</WorkingStatus>;
  }
  const statement = part.input?.sql ?? part.input?.promql;
  if (!statement) return null;
  return (
    <details
      open={open}
      className="max-w-[85%] border border-border bg-surface-2/60 text-xs"
    >
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
