"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { Compass, Database, LayoutDashboard, Search, Zap } from "lucide-react";
import {
  type Command,
  type CommandKind,
  commandsFromResults,
  EMPTY_RESULTS,
  groupCommands,
  parseRecents,
  pushRecent,
  rankCommands,
  RECENTS_STORAGE_KEY,
  type SearchResults,
  STATIC_COMMANDS,
} from "@/lib/command-palette";
import { setTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const ICONS: Record<CommandKind, typeof Search> = {
  dashboard: LayoutDashboard,
  source: Database,
  page: Compass,
  action: Zap,
};

/**
 * Cmd/Ctrl+K anywhere in the app.
 *
 * It is a navigator, not a second API surface: every result is somewhere the
 * identity can already go, decided by `GET /api/search` from the validated
 * claims. The one thing it does that is not navigation — refreshing a catalog
 * — is the same guarded POST the source list already offers, and the route
 * re-checks `source:manage` for itself.
 *
 * The listbox is hand-rolled rather than built on a menu primitive: the
 * keyboard focus has to stay in the text field while the *selection* moves,
 * which is the combobox pattern (`aria-activedescendant`), and a menu moves
 * real focus instead.
 */
export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<SearchResults>(EMPTY_RESULTS);
  const [recents, setRecents] = React.useState<string[]>([]);
  const [active, setActive] = React.useState(0);
  const [notice, setNotice] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  const commands = React.useMemo(
    () =>
      rankCommands([...commandsFromResults(results), ...STATIC_COMMANDS], query, recents),
    [results, query, recents],
  );
  const sections = React.useMemo(() => groupCommands(commands), [commands]);
  // The sections render in a fixed order, so the flat list the arrow keys walk
  // has to be the concatenation of them and not `commands` itself.
  const ordered = React.useMemo(() => sections.flatMap((s) => s.commands), [sections]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((was) => !was);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  React.useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    setNotice(null);
    try {
      setRecents(parseRecents(window.localStorage.getItem(RECENTS_STORAGE_KEY)));
    } catch {
      setRecents([]);
    }
  }, [open]);

  // The URL follows what has been typed, once typing pauses — one request per
  // pause rather than one per keystroke. The first fetch runs on open with an
  // empty query, which is what fills the list before anything is typed.
  React.useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        void fetch(`/api/search?q=${encodeURIComponent(query)}`, {
          signal: controller.signal,
        })
          .then((r) => (r.ok ? (r.json() as Promise<SearchResults>) : EMPTY_RESULTS))
          .then(setResults)
          .catch(() => {
            // An aborted or failed search leaves the static commands, which is
            // still a usable palette.
          });
      },
      query ? 150 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, query]);

  // A narrowing query can leave the selection past the end of the list.
  React.useEffect(() => {
    setActive((i) => Math.min(i, Math.max(ordered.length - 1, 0)));
  }, [ordered.length]);

  React.useEffect(() => {
    listRef.current
      ?.querySelector(`#command-option-${active}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function remember(id: string) {
    const next = pushRecent(recents, id);
    setRecents(next);
    try {
      window.localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Recents are a convenience; the palette works without them.
    }
  }

  async function run(command: Command) {
    remember(command.id);
    switch (command.action.type) {
      case "navigate":
        setOpen(false);
        router.push(command.action.href);
        return;
      case "theme":
        setTheme(command.action.theme);
        setOpen(false);
        return;
      case "refresh-catalog": {
        const { sourceId, name } = command.action;
        setNotice(`Refreshing the catalog for ${name}…`);
        const res = await fetch(`/api/sources/${sourceId}/refresh`, { method: "POST" });
        setNotice(
          res.ok
            ? `Catalog refreshed for ${name}.`
            : `Could not refresh the catalog for ${name}.`,
        );
        router.refresh();
        return;
      }
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      setActive((i) => (ordered.length ? (i + 1) % ordered.length : 0));
    } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      setActive((i) => (ordered.length ? (i - 1 + ordered.length) % ordered.length : 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(Math.max(ordered.length - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const command = ordered[active];
      if (command) void run(command);
    }
  }

  let index = -1;

  return (
    <BaseDialog.Root open={open} onOpenChange={setOpen}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-40 bg-black/60" />
        <BaseDialog.Popup
          initialFocus={inputRef}
          className="fixed inset-x-4 top-20 z-50 mx-auto w-auto max-w-xl overflow-hidden rounded-lg border border-border bg-surface shadow-xl focus:outline-none"
        >
          <BaseDialog.Title className="sr-only">Command palette</BaseDialog.Title>
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="h-4 w-4 shrink-0 text-muted" aria-hidden />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-expanded
              aria-controls="command-palette-list"
              aria-activedescendant={
                ordered[active] ? `command-option-${active}` : undefined
              }
              aria-label="Search dashboards, sources and actions"
              placeholder="Search dashboards, sources and actions…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              className="h-12 w-full bg-transparent text-sm text-foreground placeholder:text-muted focus:outline-none"
            />
          </div>

          <div
            ref={listRef}
            id="command-palette-list"
            // The APG combobox pattern: the listbox is a sibling of the input
            // that owns it, and real focus never leaves the input.
            role="listbox"
            aria-label="Results"
            className="max-h-80 overflow-y-auto p-2"
          >
            {ordered.length === 0 && (
              <p className="px-2 py-6 text-center text-sm text-muted">
                Nothing matches “{query}”.
              </p>
            )}
            {sections.map((section) => (
              <div key={section.kind} className="mb-2 last:mb-0">
                <p className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted">
                  {section.label}
                </p>
                {section.commands.map((command) => {
                  index += 1;
                  const i = index;
                  const Icon = ICONS[command.kind];
                  return (
                    // A listbox option, not a button: the input keeps focus and
                    // `aria-activedescendant` points here.
                    // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard path is the input's onKeyDown — an option in this pattern is never focused
                    <div
                      key={command.id}
                      id={`command-option-${i}`}
                      role="option"
                      aria-selected={i === active}
                      tabIndex={-1}
                      onClick={() => void run(command)}
                      onMouseMove={() => setActive(i)}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm",
                        i === active
                          ? "bg-surface-2 text-foreground"
                          : "text-muted hover:text-foreground",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-foreground">
                        {command.title}
                      </span>
                      {command.subtitle && (
                        <span className="shrink-0 truncate text-xs text-muted">
                          {command.subtitle}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          <div
            className="flex items-center justify-between gap-3 border-t border-border px-3 py-2 text-[11px] text-muted"
            aria-live="polite"
          >
            <span>{notice ?? "↑↓ to move · ↵ to run · Esc to close"}</span>
            <span className="shrink-0">⌘K</span>
          </div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
