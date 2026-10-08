"use client";

import type { EffectiveModel } from "@/lib/ai/model-config";
import * as React from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Clock,
  Columns3,
  Compass,
  Copy,
  Download,
  Filter,
  Loader2,
  Pin,
  PinOff,
  RefreshCw,
  Save,
  Search,
  SendHorizontal,
  Square,
  X,
} from "lucide-react";
import {
  hasQuery,
  ExplorePanel,
  panelTimeRange,
  type QueryPanel,
  type TimeRange,
} from "@/lib/ir";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { AiUnavailable } from "@/components/ai-unavailable";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import {
  Menu,
  MenuCheckboxItem,
  MenuRadioGroup,
  MenuRadioItem,
} from "@/components/ui/menu";
import { COMPOSER_CHIP_CLASS, SourceChipLabel } from "@/components/composer-chip";
import { AccessibleChart } from "@/components/charts/AccessibleChart";
import type { PanelData } from "@/components/charts/options";
import { panelRenderer } from "@/components/panels/registry";
import { useTimeDisplay } from "@/components/time-display";
import { ErrorDisplay } from "@/components/ui/error-display";
import { RepairingNote } from "@/components/repairing-note";
import { useRepairingObject } from "@/components/use-repairing-object";
import { useFlip } from "@/components/use-flip";
import { useReducedMotion } from "@/components/motion-preference";
import { type ApiError, apiErrorFromThrown } from "@/lib/errors";
import { EMPTY_ROWS, runPanelQuery } from "@/lib/panel-query";
import type { CatalogHealth } from "@/lib/catalog/health";
import {
  CatalogHealthNotice,
  useCatalogRefresh,
} from "@/components/sources/catalog-health";
import { formatValue } from "@/lib/format";
import { tokenHex } from "@/lib/panels/colors";
import { statReading } from "@/lib/panel-reading";
import { formatClock } from "@/lib/time-display";
import { animateOut } from "@/lib/motion";
import { NoSources } from "@/components/onboarding/no-sources";
import { PromptHistoryMenu, usePromptHistory } from "@/components/prompt-history";
import {
  initialTableView,
  initialView,
  isSeriesView,
  type TableView,
  type ViewSettings,
  viewChoices,
  viewPanel,
} from "@/lib/explore-view";
import {
  csvFilename,
  EMPTY_FILTERS,
  filterRows,
  isFiltering,
  nextSort,
  type RowFilters,
  sortRows,
  toCsv,
} from "@/lib/result-table";
import {
  addEntry,
  emptySession,
  removeEntry,
  type Session,
  showEntry,
  togglePin,
  updateEntry,
  visibleEntries,
} from "@/lib/explore-session";
import { cn } from "@/lib/utils";
import { SavePanelDialog, type SavedPanel } from "./save-panel-dialog";

interface SourceOption {
  id: string;
  name: string;
  workspaceId: string;
  /** Server-decided; the same judgement `/api/generate` refuses on. */
  catalog: CatalogHealth;
  /** Whether this caller may refresh it, i.e. holds `source:manage` here. */
  canRefresh: boolean;
  /**
   * One-click starters built from this source's catalog by `buildStarters`.
   * Per source, so switching the picker switches the chips.
   */
  starters: string[];
}

type Status = "loading" | "done" | "error";

interface Result {
  data: PanelData;
  status: Status;
  error?: ApiError;
  /** An auto-refresh or re-run is in flight; the rows on screen stay until it lands. */
  refreshing?: boolean;
  /** When these rows came back. */
  ranAt?: number;
}

/** One question asked this visit, and everything about how its answer is shown. */
interface Entry {
  id: string;
  prompt: string;
  askedAt: number;
  sourceName: string;
  workspaceId: string;
  /** The window the rows were read over, resolved by the server. */
  from: string;
  /** What the model proposed. */
  panel: QueryPanel;
  /** The panel as drawn and as it would be saved: `panel` with the toggles applied. */
  shown: QueryPanel;
  view: ViewSettings;
  table: TableView;
  filters: RowFilters;
  result: Result;
  saved: SavedPanel | null;
}

const MAX_TABLE_ROWS = 500;

const TIME_PRESETS: { value: string; label: string }[] = [
  { value: "now-5m", label: "Last 5 minutes" },
  { value: "now-15m", label: "Last 15 minutes" },
  { value: "now-1h", label: "Last 1 hour" },
  { value: "now-6h", label: "Last 6 hours" },
  { value: "now-12h", label: "Last 12 hours" },
  { value: "now-24h", label: "Last 24 hours" },
  { value: "now-7d", label: "Last 7 days" },
  { value: "now-30d", label: "Last 30 days" },
];

/** Auto-refresh choices, in milliseconds; 0 is off. */
const REFRESH_CHOICES: { value: string; label: string }[] = [
  { value: "0", label: "Off" },
  { value: "30000", label: "30s" },
  { value: "60000", label: "1m" },
  { value: "300000", label: "5m" },
];

const VIEW_LABELS: Partial<Record<string, string>> = {
  line: "Line",
  area: "Area",
  bar: "Bar",
  table: "Table",
  stat: "Stat",
};

function rangeLabel(from: string): string {
  return TIME_PRESETS.find((p) => p.value === from)?.label ?? from;
}

/** A toggle in a row of toggles: the same pill the dashboard list's tags use. */
function Pill({
  pressed,
  disabled,
  onClick,
  children,
  title,
}: {
  pressed: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(
        "inline-flex cursor-pointer items-center gap-1.5 border px-2.5 py-0.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50",
        pressed
          ? "border-primary/60 bg-primary/10 text-foreground"
          : "border-border text-muted hover:border-foreground/40 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/**
 * `/explore`: ask a question of one source and get a panel back, then look at
 * it every way the rows allow without asking the model again.
 *
 * The composer is the prompt bar `/dashboards/new` has (#362): the source chip,
 * one line to ask in, and here the time range and auto-refresh. Each answer is
 * kept for the visit in a session list, where one can be pinned beside the
 * current one to compare. A result can be redrawn as another kind, its table
 * filtered, sorted, trimmed and downloaded, and re-run or refreshed on a timer;
 * all of it over the rows the guarded query returned, with the server resolving
 * every window. Save as panel saves the panel as it is shown.
 */
export function ExploreClient({
  sources,
  models,
  canManageSources,
  defaultTimeRange,
  defaultRefreshIntervalMs,
}: {
  sources: SourceOption[];
  /**
   * The model a generation in each workspace would use, and why generation
   * cannot be attempted there (no model configured), keyed by workspace id
   * (#331). Decided on the server, the only side with the configuration.
   */
  models: Record<string, EffectiveModel>;
  /**
   * Whether this caller holds `source:manage` anywhere, which decides whether
   * the no-source empty state offers to add one or names who can.
   */
  canManageSources: boolean;
  /** Server-configured defaults, used when Explore creates a dashboard. */
  defaultTimeRange: TimeRange;
  defaultRefreshIntervalMs: number;
}) {
  const reducedMotion = useReducedMotion();
  const [sourceId, setSourceId] = React.useState<string | null>(sources[0]?.id ?? null);
  const [from, setFrom] = React.useState("now-24h");
  const [refreshMs, setRefreshMs] = React.useState(0);
  const [prompt, setPrompt] = React.useState("");
  const [session, setSession] = React.useState<Session<Entry>>(emptySession);
  // The entry whose Save as panel dialog is open.
  const [savingId, setSavingId] = React.useState<string | null>(null);
  // Catalog state for the picker, corrected in place by a Refresh from here.
  const catalog = useCatalogRefresh(
    Object.fromEntries(sources.map((s) => [s.id, s.catalog])),
  );
  const source = sources.find((s) => s.id === sourceId);
  const effective = source ? models[source.workspaceId] : undefined;
  const model = effective?.model ?? "";
  const aiUnavailable = effective?.unavailable ?? null;
  // Recent Explore questions for this workspace, offered back from the header (#83).
  const prompts = usePromptHistory(source?.workspaceId, "explore");
  // Chips for the selected source. Server-built from its catalog, so they
  // change with the picker and never describe a table this source cannot read.
  const starters = source?.starters ?? [];

  const nextId = React.useRef(0);
  // The latest run per entry; an older one landing late is dropped.
  const runs = React.useRef(new Map<string, number>());
  // What was asked, held for the stream's finish rather than read off the box.
  const asked = React.useRef<{
    prompt: string;
    source: SourceOption;
    from: string;
  } | null>(null);

  const runEntry = React.useCallback(
    async (id: string, panel: QueryPanel, rangeFrom: string, quiet = false) => {
      const seq = (runs.current.get(id) ?? 0) + 1;
      runs.current.set(id, seq);
      setSession((s) =>
        updateEntry(s, id, (e) => ({
          ...e,
          from: rangeFrom,
          result:
            quiet && e.result.status === "done"
              ? { ...e.result, refreshing: true }
              : { data: EMPTY_ROWS, status: "loading" },
        })),
      );
      const outcome = await runPanelQuery(
        panel.query,
        panelTimeRange(panel, { from: rangeFrom, to: "now" }),
      );
      if (runs.current.get(id) !== seq) return;
      setSession((s) =>
        updateEntry(s, id, (e) => ({
          ...e,
          result: outcome.ok
            ? { data: outcome.rows, status: "done", ranAt: Date.now() }
            : { data: EMPTY_ROWS, status: "error", error: outcome.error },
        })),
      );
    },
    [],
  );

  const { object, submit, isLoading, error, stop, repairing } = useRepairingObject({
    api: "/api/generate",
    schema: ExplorePanel,
    onFinish({ object }) {
      const question = asked.current;
      // `ExplorePanel` refuses a query-less panel; the guard says so to the type.
      if (!object || !question || !hasQuery(object)) return;
      // The panel query carries the source id; pin it to the source asked of.
      const panel: QueryPanel = {
        ...object,
        query: { ...object.query, sourceId: question.source.id },
      };
      nextId.current += 1;
      const id = `q${nextId.current}`;
      const entry: Entry = {
        id,
        prompt: question.prompt,
        askedAt: Date.now(),
        sourceName: question.source.name,
        workspaceId: question.source.workspaceId,
        from: question.from,
        panel,
        shown: panel,
        view: initialView(panel),
        table: initialTableView(panel),
        filters: EMPTY_FILTERS,
        result: { data: EMPTY_ROWS, status: "loading" },
        saved: null,
      };
      setSession((s) => addEntry(s, entry));
      void runEntry(id, panel, question.from);
      // Clear the box only if the next question has not been started in it.
      setPrompt((p) => (p === question.prompt ? "" : p));
    },
  });

  function ask() {
    if (!source || !prompt.trim() || isLoading || aiUnavailable) return;
    prompts.remember(prompt);
    asked.current = { prompt, source, from };
    submit({ mode: "explore", sourceId: source.id, prompt });
  }

  const visible = visibleEntries(session);

  // The window applies to what is on screen: re-run each over the new one.
  function changeRange(next: string) {
    setFrom(next);
    for (const e of visible) void runEntry(e.id, e.shown, next);
  }

  // Auto-refresh what is on screen, quietly, and not while the tab is hidden.
  // The timer reads the latest entries from a ref, so it is not reset by them.
  const onScreen = React.useRef<Entry[]>([]);
  React.useEffect(() => {
    onScreen.current = visible;
  });
  React.useEffect(() => {
    if (refreshMs <= 0) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      for (const e of onScreen.current) void runEntry(e.id, e.shown, e.from, true);
    }, refreshMs);
    return () => window.clearInterval(timer);
  }, [refreshMs, runEntry]);

  /** Apply a change of view or table settings, if it makes a valid panel. */
  function changeView(id: string, view: ViewSettings, table: TableView) {
    setSession((s) =>
      updateEntry(s, id, (e) => {
        const shown = viewPanel(e.panel, view, table);
        return shown ? { ...e, view, table, shown } : e;
      }),
    );
  }

  async function remove(id: string, row: HTMLElement | null) {
    if (row) await animateOut(row, !reducedMotion);
    runs.current.delete(id);
    setSession((s) => removeEntry(s, id));
  }

  const header = (
    <PageHeader
      title="Explore"
      badge={model && <Badge title="Generation model">{model}</Badge>}
      description={
        <>
          Ask a question in plain English. Results come back as text and tables; ask to
          &ldquo;chart&rdquo;, &ldquo;plot&rdquo;, or &ldquo;graph&rdquo; something to get
          a visualization, or switch the view once it is back.
        </>
      }
      actions={
        <PromptHistoryMenu history={prompts} disabled={isLoading} onPick={setPrompt} />
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

  const fresh = session.entries.length === 0 && !isLoading;
  const savingEntry = session.entries.find((e) => e.id === savingId);

  return (
    <div className="w-full space-y-6">
      {header}

      {/*
        The composer: the source asked of, one line to ask in, and the window
        and refresh every answer on screen is read over.
      */}
      <section aria-label="Question" className="space-y-3">
        <form
          className="flex flex-wrap items-center gap-2 lg:flex-nowrap"
          onSubmit={(e) => {
            e.preventDefault();
            ask();
          }}
        >
          {source && (
            <Menu
              label={`Data source: ${source.name}, workspace ${source.workspaceId}`}
              className={COMPOSER_CHIP_CLASS}
              panelClassName="max-w-sm"
              trigger={
                <SourceChipLabel name={source.name} workspaceId={source.workspaceId} />
              }
            >
              <MenuRadioGroup
                label="Source"
                value={source.id}
                onValueChange={setSourceId}
              >
                {sources.map((s) => (
                  <MenuRadioItem key={s.id} value={s.id}>
                    <span className="truncate">{s.name}</span>
                    <span className="text-xs text-muted">{s.workspaceId}</span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </Menu>
          )}
          <Label htmlFor="prompt" className="sr-only">
            Ask a question
          </Label>
          {/* On a narrow screen the box takes its own row under the chips. */}
          <div className="relative order-last min-w-0 flex-1 basis-full lg:order-none lg:basis-auto">
            <Input
              id="prompt"
              disabled={aiUnavailable !== null}
              className="pr-12"
              placeholder={
                starters[0]
                  ? `e.g. ${starters[0]} (add “as a chart” to visualize)`
                  : "Ask a question about this data source (add “as a chart” to visualize)"
              }
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
            {isLoading ? (
              <Button
                type="button"
                size="icon"
                variant="secondary"
                onClick={() => stop()}
                aria-label="Stop"
                title="Stop"
                className="absolute top-1 right-1 h-8 w-8"
              >
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon"
                disabled={!prompt.trim() || aiUnavailable !== null}
                aria-label="Explore"
                title="Explore"
                className="absolute top-1 right-1 h-8 w-8"
              >
                <SendHorizontal className="h-4 w-4" />
              </Button>
            )}
          </div>
          <Menu
            label={`Time range: ${rangeLabel(from)}`}
            className={COMPOSER_CHIP_CLASS}
            trigger={
              <>
                <Clock className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
                <span className="truncate">{rangeLabel(from)}</span>
              </>
            }
          >
            <MenuRadioGroup label="Time range" value={from} onValueChange={changeRange}>
              {TIME_PRESETS.map((p) => (
                <MenuRadioItem key={p.value} value={p.value}>
                  {p.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </Menu>
          <Menu
            label={`Auto-refresh: ${refreshMs > 0 ? `every ${REFRESH_CHOICES.find((c) => c.value === String(refreshMs))?.label}` : "off"}`}
            className={COMPOSER_CHIP_CLASS}
            trigger={
              <>
                <RefreshCw
                  className={cn(
                    "h-3.5 w-3.5 shrink-0",
                    refreshMs > 0 ? "text-primary" : "text-muted",
                  )}
                  aria-hidden
                />
                <span>
                  {REFRESH_CHOICES.find((c) => c.value === String(refreshMs))?.label ??
                    "Off"}
                </span>
              </>
            }
          >
            <MenuRadioGroup
              label="Auto-refresh"
              value={String(refreshMs)}
              onValueChange={(v) => setRefreshMs(Number(v))}
            >
              {REFRESH_CHOICES.map((c) => (
                <MenuRadioItem key={c.value} value={c.value}>
                  {c.value === "0" ? "Off" : `Every ${c.label}`}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </Menu>
        </form>

        {/* A few of the source's starters, before the first question only. */}
        {fresh && starters.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {starters.slice(0, 3).map((example) => (
              <button
                key={example}
                type="button"
                disabled={aiUnavailable !== null}
                onClick={() => setPrompt(example)}
                className="border border-border bg-surface px-3 py-1 text-left text-xs text-muted transition-colors hover:border-primary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                {example}
              </button>
            ))}
          </div>
        )}

        {source && (
          <CatalogHealthNotice
            source={source}
            health={catalog.health[source.id]}
            canRefresh={source.canRefresh}
            onRefreshed={(health) => catalog.update(source.id, health)}
          />
        )}
        {aiUnavailable && <AiUnavailable message={aiUnavailable} />}
        <RepairingNote show={repairing} />
        {error && (
          <ErrorDisplay
            error={apiErrorFromThrown(error)}
            onRetry={ask}
            retryLabel="Try again"
            disabled={isLoading}
          />
        )}
      </section>

      {(session.entries.length > 0 || isLoading) && (
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div
            className={cn(
              "grid min-w-0 grid-cols-1 gap-8",
              visible.length > 1 && "xl:grid-cols-2",
            )}
          >
            {isLoading && (
              <div className="flex items-center gap-2 text-sm text-muted xl:col-span-2">
                <Compass className="h-4 w-4 animate-pulse" />
                {object?.title ? `Composing “${object.title}”…` : "Composing a query…"}
              </div>
            )}
            {visible.map((e) => (
              <ResultView
                key={e.id}
                entry={e}
                pinned={e.id === session.pinnedId}
                onPin={() => setSession((s) => togglePin(s, e.id))}
                onRerun={() => void runEntry(e.id, e.shown, e.from, true)}
                onView={(view) => changeView(e.id, view, e.table)}
                onTable={(table) => changeView(e.id, e.view, table)}
                onFilters={(filters) =>
                  setSession((s) => updateEntry(s, e.id, (x) => ({ ...x, filters })))
                }
                onSave={() => setSavingId(e.id)}
              />
            ))}
          </div>
          <SessionList
            session={session}
            onShow={(id) => setSession((s) => showEntry(s, id))}
            onPin={(id) => setSession((s) => togglePin(s, id))}
            onRemove={(id, row) => void remove(id, row)}
          />
        </div>
      )}

      {savingEntry && (
        <SavePanelDialog
          open
          onOpenChange={(open) => {
            if (!open) setSavingId(null);
          }}
          panel={savingEntry.shown}
          workspaceId={savingEntry.workspaceId}
          defaultTimeRange={defaultTimeRange}
          defaultRefreshIntervalMs={defaultRefreshIntervalMs}
          onSaved={(saved) =>
            setSession((s) => updateEntry(s, savingEntry.id, (x) => ({ ...x, saved })))
          }
        />
      )}
    </div>
  );
}

/** The visit's questions, newest first: show one, pin one, or drop one. */
function SessionList({
  session,
  onShow,
  onPin,
  onRemove,
}: {
  session: Session<Entry>;
  onShow: (id: string) => void;
  onPin: (id: string) => void;
  onRemove: (id: string, row: HTMLElement | null) => void;
}) {
  const display = useTimeDisplay();
  const reducedMotion = useReducedMotion();
  const list = React.useRef<HTMLOListElement>(null);
  useFlip(list, !reducedMotion);
  return (
    <aside aria-label="This session" className="min-w-0 space-y-2 lg:sticky lg:top-20">
      <h2 className="text-sm font-medium text-muted">This session</h2>
      {session.entries.length === 0 ? (
        <p className="text-xs text-muted">Your questions will be listed here.</p>
      ) : (
        <ol ref={list} className="space-y-1.5">
          {session.entries.map((e) => {
            const active = e.id === session.activeId;
            const pinned = e.id === session.pinnedId;
            return (
              <li
                key={e.id}
                data-flip-id={e.id}
                className={cn(
                  "flex items-start border transition-colors",
                  active ? "border-primary bg-surface-2" : "border-border bg-surface",
                )}
              >
                <button
                  type="button"
                  aria-current={active ? "true" : undefined}
                  onClick={() => onShow(e.id)}
                  className="min-w-0 flex-1 cursor-pointer px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-primary"
                >
                  <span
                    className="block truncate text-sm text-foreground"
                    title={e.prompt}
                  >
                    {e.prompt}
                  </span>
                  <span className="block text-xs text-muted">
                    {VIEW_LABELS[e.shown.viz] ?? e.shown.viz} ·{" "}
                    {formatClock(new Date(e.askedAt), display).slice(0, -3)}
                    {e.result.status === "error" && " · failed"}
                  </span>
                </button>
                <button
                  type="button"
                  aria-pressed={pinned}
                  aria-label={
                    pinned ? `Unpin “${e.prompt}”` : `Pin “${e.prompt}” to compare`
                  }
                  title={pinned ? "Unpin" : "Pin to compare"}
                  onClick={() => onPin(e.id)}
                  className={cn(
                    "tap-target inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center self-center transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary",
                    pinned ? "text-primary" : "text-muted",
                  )}
                >
                  <Pin className={cn("h-3.5 w-3.5", pinned && "fill-current")} />
                </button>
                <button
                  type="button"
                  aria-label={`Remove “${e.prompt}”`}
                  title="Remove"
                  onClick={(ev) => onRemove(e.id, ev.currentTarget.closest("li"))}
                  className="tap-target mr-1 inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center self-center text-muted transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            );
          })}
        </ol>
      )}
      <p className="text-xs text-muted">
        Kept for this visit only. Pin one to compare it beside the result you are looking
        at.
      </p>
    </aside>
  );
}

function ResultView({
  entry,
  pinned,
  onPin,
  onRerun,
  onView,
  onTable,
  onFilters,
  onSave,
}: {
  entry: Entry;
  pinned: boolean;
  onPin: () => void;
  onRerun: () => void;
  onView: (view: ViewSettings) => void;
  onTable: (table: TableView) => void;
  onFilters: (filters: RowFilters) => void;
  onSave: () => void;
}) {
  const display = useTimeDisplay();
  const { panel, shown, view, table, result, saved } = entry;
  const rowCount = result.data.rows.length;
  const series = isSeriesView(view.viz);
  // A toggle is offered only when the panel it would make is valid.
  const allowed = (next: ViewSettings) => viewPanel(panel, next, table) !== null;
  const [copied, setCopied] = React.useState(false);

  return (
    <section aria-label={`Result: ${shown.title}`} className="fade-in min-w-0 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="flex items-center gap-2 text-lg font-medium">
            {pinned && (
              <Pin
                className="h-4 w-4 shrink-0 fill-current text-primary"
                aria-label="Pinned"
              />
            )}
            <span className="truncate">{shown.title}</span>
          </h2>
          {shown.description && <p className="text-sm text-muted">{shown.description}</p>}
          <p className="flex flex-wrap items-center gap-1 text-xs text-muted">
            {entry.sourceName} · {rangeLabel(entry.from)}
            {result.status === "done" && ` · ${rowCount} row${rowCount === 1 ? "" : "s"}`}
            {result.ranAt && ` · ran ${formatClock(new Date(result.ranAt), display)}`}
            {result.refreshing && (
              <Loader2 className="h-3 w-3 animate-spin" aria-label="Refreshing" />
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onPin} aria-pressed={pinned}>
            {pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
            {pinned ? "Unpin" : "Pin"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onRerun}
            disabled={result.status === "loading" || result.refreshing}
          >
            <RefreshCw className="h-4 w-4" /> Re-run
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={onSave}
            disabled={result.status !== "done"}
          >
            <Save className="h-4 w-4" /> Save as panel
          </Button>
        </div>
      </div>

      {saved && (
        <p className="flex flex-wrap items-center gap-1 border border-border bg-surface px-4 py-2 text-sm text-muted">
          Saved as a panel.
          <Link
            href={`/dashboards/${saved.dashboardId}`}
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            Open the dashboard <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        </p>
      )}

      {/* How to draw it: the kinds the rows can feed, then the series toggles. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <fieldset className="flex flex-wrap items-center gap-1.5">
          <legend className="sr-only">Show as</legend>
          {viewChoices(panel).map((viz) => {
            const next = { ...view, viz };
            return (
              <Pill
                key={viz}
                pressed={view.viz === viz}
                disabled={!allowed(next)}
                onClick={() => onView(next)}
              >
                {VIEW_LABELS[viz] ?? viz}
              </Pill>
            );
          })}
        </fieldset>
        {series && (
          <fieldset className="flex flex-wrap items-center gap-1.5">
            <legend className="sr-only">Chart options</legend>
            {(
              [
                ["legend", "Legend"],
                ["stacked", "Stack"],
                ["log", "Log scale"],
              ] as const
            ).map(([key, label]) => {
              const next = { ...view, [key]: !view[key] };
              return (
                <Pill
                  key={key}
                  pressed={view[key]}
                  disabled={!allowed(next)}
                  title={
                    key === "log" && !allowed(next)
                      ? "A log axis needs values above zero"
                      : undefined
                  }
                  onClick={() => onView(next)}
                >
                  {label}
                </Pill>
              );
            })}
          </fieldset>
        )}
      </div>

      <ResultBody
        entry={entry}
        onRetry={onRerun}
        onTable={onTable}
        onFilters={onFilters}
      />

      <details className="border border-border bg-surface">
        <summary className="cursor-pointer px-4 py-2 text-sm text-muted">
          Generated SQL
        </summary>
        <div className="relative border-t border-border">
          <Button
            variant="ghost"
            size="sm"
            className="absolute top-1 right-1"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(panel.query.sql)
                .then(() => setCopied(true));
            }}
          >
            <Copy className="h-3.5 w-3.5" /> {copied ? "Copied" : "Copy"}
          </Button>
          <pre className="overflow-auto px-4 py-3 pr-24 text-xs text-muted">
            {panel.query.sql}
          </pre>
        </div>
      </details>
    </section>
  );
}

function ResultBody({
  entry,
  onRetry,
  onTable,
  onFilters,
}: {
  entry: Entry;
  onRetry: () => void;
  onTable: (table: TableView) => void;
  onFilters: (filters: RowFilters) => void;
}) {
  const display = useTimeDisplay();
  const { shown, result } = entry;
  const data = result.data;
  if (result.status === "loading") {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Loader2 className="h-4 w-4 animate-spin" /> Running query…
      </div>
    );
  }
  if (result.status === "error") {
    return (
      <ErrorDisplay
        error={result.error ?? { error: "Query failed", kind: "statement" }}
        onRetry={onRetry}
      />
    );
  }
  if (data.rows.length === 0) {
    return <p className="text-sm text-muted">No rows returned for this window.</p>;
  }

  // Every chart kind is plotted, from the panel registry (#61); the HTML kinds
  // get explore's own wider stat and table below.
  const renderer = panelRenderer(shown.viz);
  if (renderer.type === "chart") {
    return (
      <div className="h-96 border border-border bg-surface p-2">
        <AccessibleChart
          panel={shown}
          data={data}
          option={renderer.option(shown, data, { display, window: data.window })}
        />
      </div>
    );
  }
  if (shown.viz === "stat") {
    return <StatView panel={shown} data={data} />;
  }
  return (
    <ResultTable
      panel={shown}
      data={data}
      table={entry.table}
      filters={entry.filters}
      onTable={onTable}
      onFilters={onFilters}
    />
  );
}

function StatView({ panel, data }: { panel: QueryPanel; data: PanelData }) {
  // The dashboard's own reading, so a value column or threshold the model
  // chose is shown here as it will be there.
  const reading = statReading(panel, data);
  return (
    <div className="border border-border bg-surface px-6 py-8">
      <div
        className="text-4xl font-semibold tabular-nums"
        style={reading.color ? { color: tokenHex(reading.color) } : undefined}
      >
        {reading.text}
      </div>
      <div className="mt-1 text-sm text-muted">{reading.column}</div>
    </div>
  );
}

/** Save text as a file through the browser; nothing leaves the page. */
function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function ResultTable({
  panel,
  data,
  table,
  filters,
  onTable,
  onFilters,
}: {
  panel: QueryPanel;
  data: PanelData;
  table: TableView;
  filters: RowFilters;
  onTable: (table: TableView) => void;
  onFilters: (filters: RowFilters) => void;
}) {
  const [columnFilters, setColumnFilters] = React.useState(
    Object.values(filters.columns).some((v) => v.trim() !== ""),
  );
  const columns = data.columns.filter((c) => !table.hidden.includes(c));
  const matching = sortRows(filterRows(data.rows, columns, filters), table.sort);
  const rows = matching.slice(0, MAX_TABLE_ROWS);
  const filtering = isFiltering(filters);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted"
            aria-hidden
          />
          <Input
            aria-label="Filter rows"
            placeholder="Filter rows…"
            value={filters.text}
            onChange={(e) => onFilters({ ...filters, text: e.target.value })}
            className="h-8 pl-8 text-xs"
          />
        </div>
        <Menu
          label="Columns"
          className="h-8 w-auto gap-1.5 px-2 text-sm"
          trigger={
            <>
              <Columns3 className="h-4 w-4" aria-hidden /> Columns
              {table.hidden.length > 0 && (
                <span className="text-xs text-muted">({table.hidden.length} hidden)</span>
              )}
            </>
          }
        >
          {data.columns.map((c) => {
            const shown = !table.hidden.includes(c);
            return (
              <MenuCheckboxItem
                key={c}
                checked={shown}
                // The last visible column stays: a table of nothing is no view.
                disabled={shown && columns.length === 1}
                onCheckedChange={(next) =>
                  onTable({
                    ...table,
                    hidden: next
                      ? table.hidden.filter((h) => h !== c)
                      : [...table.hidden, c],
                  })
                }
              >
                <span className="truncate">{c}</span>
              </MenuCheckboxItem>
            );
          })}
        </Menu>
        <Pill
          pressed={columnFilters}
          onClick={() => {
            if (columnFilters) onFilters({ ...filters, columns: {} });
            setColumnFilters(!columnFilters);
          }}
        >
          <Filter className="h-3 w-3" aria-hidden /> Column filters
        </Pill>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => download(csvFilename(panel.title), toCsv(columns, matching))}
        >
          <Download className="h-4 w-4" /> CSV
        </Button>
      </div>

      <section
        aria-label={`${panel.title}, table`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container must be focusable to scroll by keyboard (WCAG 2.1.1)
        tabIndex={0}
        className="max-h-[32rem] overflow-auto border border-border focus-visible:outline-2 focus-visible:outline-primary"
      >
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-surface-2 text-muted">
            <tr>
              {columns.map((c) => {
                const sorted = table.sort?.column === c ? table.sort.order : null;
                return (
                  <th
                    key={c}
                    aria-sort={
                      sorted === "asc"
                        ? "ascending"
                        : sorted === "desc"
                          ? "descending"
                          : undefined
                    }
                    className="px-3 py-2 font-medium"
                  >
                    <button
                      type="button"
                      onClick={() => onTable({ ...table, sort: nextSort(table.sort, c) })}
                      className="inline-flex cursor-pointer items-center gap-1 hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
                    >
                      {c}
                      <span aria-hidden className="text-xs">
                        {sorted === "asc" ? "▲" : sorted === "desc" ? "▼" : ""}
                      </span>
                    </button>
                  </th>
                );
              })}
            </tr>
            {columnFilters && (
              <tr>
                {columns.map((c) => (
                  <th key={c} className="px-2 pb-2 font-normal">
                    <Input
                      aria-label={`Filter ${c}`}
                      placeholder="contains…"
                      value={filters.columns[c] ?? ""}
                      onChange={(e) =>
                        onFilters({
                          ...filters,
                          columns: { ...filters.columns, [c]: e.target.value },
                        })
                      }
                      className="h-7 min-w-20 px-2 text-xs"
                    />
                  </th>
                ))}
              </tr>
            )}
          </thead>
          <tbody>
            {rows.map((r, i) => (
              // Query result rows carry no stable identity, and the table is
              // render-only — nothing is reordered, edited or keyed off state.
              // biome-ignore lint/suspicious/noArrayIndexKey: result rows have no id
              <tr key={i} className="border-t border-border">
                {columns.map((c) => (
                  <td key={c} className="px-3 py-1.5 tabular-nums">
                    {formatCell(
                      r[c],
                      c === panel.query.timeField ? undefined : panel.format,
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <p className="text-xs text-muted">
        {filtering
          ? `${matching.length} of ${data.rows.length} rows match.`
          : `${data.rows.length} rows.`}
        {matching.length > MAX_TABLE_ROWS &&
          ` Showing the first ${MAX_TABLE_ROWS}; CSV has them all.`}
      </p>
    </div>
  );
}

function formatCell(value: unknown, format: QueryPanel["format"]): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" && format) return formatValue(value, format);
  return String(value);
}
