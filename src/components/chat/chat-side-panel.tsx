"use client";

import * as React from "react";
import Link from "next/link";
import { Check, Pencil, Trash2, X } from "lucide-react";
import { useReducedMotion } from "@/components/motion-preference";
import { useFlip } from "@/components/use-flip";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  deleteAllConversations,
  deleteConversation,
  listConversations,
  updateConversation,
} from "@/lib/chat/client";
import {
  type ConversationEntry,
  entryTitle,
  filterConversations,
  groupConversations,
} from "@/lib/chat/history";
import type { ChatSourceOption } from "@/lib/chat/page-data";
import { CHAT_REFRESH_CHOICES, CHAT_TIME_RANGES } from "@/lib/chat/defaults";
import { animateOut } from "@/lib/motion";
import type { ChatPreferences } from "@/lib/preferences";
import { cn } from "@/lib/utils";

const SECTION_TITLE = "text-xs font-semibold tracking-wide text-muted uppercase";

/**
 * Chat's side panel (#416): the sources the conversation may use, this
 * person's past conversations, and the settings. Drawn in the `aside` on a
 * wide screen and in a dialog below `md`; the same content in both.
 */
export function ChatSidePanel({
  sources,
  selected,
  workspaceId,
  conversationId,
  busy,
  sourcesNote,
  onToggleSource,
  timeRange,
  onTimeRange,
  prefs,
  onPrefs,
  historyKey,
}: {
  sources: ChatSourceOption[];
  selected: string[];
  workspaceId?: string;
  conversationId: string | null;
  busy: boolean;
  /** Why the sources cannot be changed here, when they cannot. */
  sourcesNote?: string;
  onToggleSource: (id: string, on: boolean) => void;
  timeRange: string;
  onTimeRange: (from: string) => void;
  prefs: ChatPreferences;
  onPrefs: (patch: Partial<ChatPreferences>) => void;
  /** Bumped when a conversation is made or answered, so the list reloads. */
  historyKey: number;
}) {
  return (
    <div className="flex flex-col gap-6">
      <SourcesSection
        sources={sources}
        selected={selected}
        workspaceId={workspaceId}
        locked={conversationId !== null}
        busy={busy}
        note={sourcesNote}
        onToggle={onToggleSource}
      />
      <HistorySection
        currentId={conversationId}
        remember={prefs.remember}
        reloadKey={historyKey}
      />
      <SettingsSection
        timeRange={timeRange}
        onTimeRange={onTimeRange}
        prefs={prefs}
        onPrefs={onPrefs}
      />
    </div>
  );
}

function SourcesSection({
  sources,
  selected,
  workspaceId,
  locked,
  busy,
  note,
  onToggle,
}: {
  sources: ChatSourceOption[];
  selected: string[];
  workspaceId?: string;
  locked: boolean;
  busy: boolean;
  note?: string;
  onToggle: (id: string, on: boolean) => void;
}) {
  const byWorkspace = new Map<string, ChatSourceOption[]>();
  for (const s of sources) {
    byWorkspace.set(s.workspaceId, [...(byWorkspace.get(s.workspaceId) ?? []), s]);
  }
  return (
    <section aria-labelledby="chat-sources" className="space-y-2">
      <h2 id="chat-sources" className={SECTION_TITLE}>
        Sources
      </h2>
      {[...byWorkspace].map(([ws, list]) => (
        <fieldset key={ws} className="space-y-1">
          <legend className="text-xs text-muted">{ws}</legend>
          {list.map((s) => {
            const other = locked && ws !== workspaceId;
            const full =
              !selected.includes(s.id) && selected.length >= 3 && ws === workspaceId;
            return (
              <div key={s.id} className="flex items-center justify-between gap-2">
                <Checkbox
                  checked={selected.includes(s.id)}
                  disabled={other || full || busy}
                  onCheckedChange={(on) => onToggle(s.id, on)}
                  label={<span className="truncate">{s.name}</span>}
                  className="min-w-0"
                />
                <span className="shrink-0 text-xs text-muted">
                  {s.catalog.blocked
                    ? "not ready"
                    : s.language === "promql"
                      ? "PromQL"
                      : "SQL"}
                </span>
              </div>
            );
          })}
        </fieldset>
      ))}
      {note && <p className="text-xs text-muted">{note}</p>}
      {locked && byWorkspace.size > 1 && (
        <p className="text-xs text-muted">
          A conversation stays in one workspace. Start a new one for another.
        </p>
      )}
    </section>
  );
}

function HistorySection({
  currentId,
  remember,
  reloadKey,
}: {
  currentId: string | null;
  remember: boolean;
  reloadKey: number;
}) {
  const [entries, setEntries] = React.useState<ConversationEntry[]>([]);
  const [next, setNext] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [filter, setFilter] = React.useState("");
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const [confirmAll, setConfirmAll] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  useFlip(listRef, !reduced);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is a deliberate reload trigger
  React.useEffect(() => {
    if (!remember) {
      setEntries([]);
      return;
    }
    let live = true;
    setLoading(true);
    void listConversations().then((page) => {
      if (!live) return;
      setLoading(false);
      if (!page.ok) {
        setProblem(page.error.error);
        return;
      }
      setEntries(page.value.conversations);
      setNext(page.value.next);
    });
    return () => {
      live = false;
    };
  }, [remember, reloadKey]);

  async function more() {
    if (!next) return;
    const page = await listConversations(next);
    if (!page.ok) {
      setProblem(page.error.error);
      return;
    }
    setEntries((e) => [...e, ...page.value.conversations]);
    setNext(page.value.next);
  }

  async function remove(id: string) {
    // The row leaves first, so the others slide into a real gap.
    const row = listRef.current?.querySelector<HTMLElement>(`[data-flip-id="${id}"]`);
    if (row) await animateOut(row, !reduced);
    const done = await deleteConversation(id);
    if (!done.ok) {
      setProblem(done.error.error);
      return;
    }
    setEntries((e) => e.filter((c) => c.id !== id));
    if (id === currentId) window.location.assign("/chat");
  }

  async function removeAll() {
    const done = await deleteAllConversations();
    if (!done.ok) {
      setProblem(done.error.error);
      return;
    }
    setEntries([]);
    setNext(null);
    if (currentId) window.location.assign("/chat");
  }

  async function rename(id: string, title: string) {
    setRenaming(null);
    const trimmed = title.trim();
    if (!trimmed) return;
    const done = await updateConversation(id, { title: trimmed });
    if (!done.ok) {
      setProblem(done.error.error);
      return;
    }
    setEntries((e) => e.map((c) => (c.id === id ? { ...c, title: trimmed } : c)));
  }

  const shown = filterConversations(entries, filter);

  return (
    <nav aria-labelledby="chat-history" className="space-y-2">
      <h2 id="chat-history" className={SECTION_TITLE}>
        History
      </h2>
      {!remember ? (
        <p className="text-xs text-muted">
          Conversations are not kept. This one is gone when you leave the page. Turn on
          Keep my conversations in Settings below to keep them.
        </p>
      ) : (
        <>
          <Label htmlFor="chat-history-filter" className="sr-only">
            Filter conversations
          </Label>
          <Input
            id="chat-history-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter conversations"
            className="h-8 text-xs"
          />
          {problem && <p className="text-xs text-danger">{problem}</p>}
          <div ref={listRef} className="space-y-3">
            {loading && entries.length === 0 && (
              <p className="text-xs text-muted">Loading…</p>
            )}
            {!loading && shown.length === 0 && (
              <p className="text-xs text-muted">
                {entries.length === 0 ? "No conversations yet." : "Nothing matches."}
              </p>
            )}
            {groupConversations(shown).map(({ group, entries: list }) => (
              <div key={group} className="space-y-0.5">
                <p className="text-xs text-muted">{group}</p>
                <ul className="space-y-0.5">
                  {list.map((c) => (
                    <li
                      key={c.id}
                      data-flip-id={c.id}
                      className={cn(
                        "group flex items-center gap-1",
                        c.id === currentId && "bg-surface-2",
                      )}
                    >
                      {renaming === c.id ? (
                        <RenameField
                          initial={c.title}
                          onDone={(title) => void rename(c.id, title)}
                          onCancel={() => setRenaming(null)}
                        />
                      ) : (
                        <>
                          <Link
                            href={`/chat/${c.id}`}
                            aria-current={c.id === currentId ? "page" : undefined}
                            className="min-w-0 flex-1 truncate px-2 py-1.5 text-sm text-foreground hover:bg-surface-2"
                          >
                            {entryTitle(c)}
                          </Link>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 shrink-0"
                            aria-label={`Rename ${entryTitle(c)}`}
                            onClick={() => setRenaming(c.id)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 shrink-0"
                            aria-label={`Delete ${entryTitle(c)}`}
                            onClick={() => void remove(c.id)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          {next && (
            <Button variant="ghost" size="sm" onClick={() => void more()}>
              Show more
            </Button>
          )}
          {entries.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="text-danger"
              onClick={() => setConfirmAll(true)}
            >
              Delete all conversations
            </Button>
          )}
          <ConfirmDialog
            open={confirmAll}
            onOpenChange={setConfirmAll}
            title="Delete all conversations?"
            confirmLabel="Delete all"
            danger
            onConfirm={() => void removeAll()}
          >
            Every conversation you have kept is deleted, at once. This cannot be undone.
          </ConfirmDialog>
        </>
      )}
    </nav>
  );
}

function RenameField({
  initial,
  onDone,
  onCancel,
}: {
  initial: string;
  onDone: (title: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = React.useState(initial);
  const id = React.useId();
  return (
    <form
      className="flex min-w-0 flex-1 items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        onDone(value);
      }}
    >
      <Label htmlFor={id} className="sr-only">
        Conversation title
      </Label>
      <Input
        id={id}
        // biome-ignore lint/a11y/noAutofocus: the rename was just asked for here
        autoFocus
        value={value}
        maxLength={80}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
        className="h-7 min-w-0 flex-1 text-sm"
      />
      <Button
        type="submit"
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        aria-label="Save title"
      >
        <Check className="h-3.5 w-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        aria-label="Cancel rename"
        onClick={onCancel}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </form>
  );
}

const RANGE_OPTIONS = CHAT_TIME_RANGES.map((r) => ({
  value: r.value,
  label: r.label,
}));
const REFRESH_OPTIONS = CHAT_REFRESH_CHOICES.map((c) => ({
  value: String(c.value),
  label: c.label,
}));

function SettingsSection({
  timeRange,
  onTimeRange,
  prefs,
  onPrefs,
}: {
  timeRange: string;
  onTimeRange: (from: string) => void;
  prefs: ChatPreferences;
  onPrefs: (patch: Partial<ChatPreferences>) => void;
}) {
  const [confirmForget, setConfirmForget] = React.useState(false);
  return (
    <section aria-labelledby="chat-settings" className="space-y-3">
      <h2 id="chat-settings" className={SECTION_TITLE}>
        Settings
      </h2>
      <div className="space-y-1">
        <Label htmlFor="chat-range" className="text-xs">
          Time range
        </Label>
        <Select
          id="chat-range"
          value={timeRange}
          options={RANGE_OPTIONS}
          onValueChange={onTimeRange}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="chat-refresh" className="text-xs">
          Live refresh
        </Label>
        <Select
          id="chat-refresh"
          value={String(prefs.refreshMs)}
          options={REFRESH_OPTIONS}
          onValueChange={(v) =>
            onPrefs({ refreshMs: Number(v) as ChatPreferences["refreshMs"] })
          }
        />
      </div>
      <Checkbox
        checked={prefs.showQueries}
        onCheckedChange={(on) => onPrefs({ showQueries: on })}
        label="Show queries"
      />
      <Checkbox
        checked={prefs.remember}
        onCheckedChange={(on) =>
          on ? onPrefs({ remember: true }) : setConfirmForget(true)
        }
        label="Keep my conversations"
      />
      <ConfirmDialog
        open={confirmForget}
        onOpenChange={setConfirmForget}
        title="Stop keeping conversations?"
        confirmLabel="Stop and delete"
        danger
        onConfirm={() => onPrefs({ remember: false })}
      >
        Every conversation you have kept is deleted, and new ones are gone when you leave
        the page. This follows you to every device you sign in on.
      </ConfirmDialog>
    </section>
  );
}
