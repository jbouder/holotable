"use client";

import * as React from "react";
import { Database, Eye, Loader2, RotateCcw, TriangleAlert } from "lucide-react";
import { PanelView, type PanelState } from "@/components/dashboard/PanelView";
import { PanelSkeleton } from "@/components/dashboard/PanelSkeleton";
import { CopyButton } from "@/components/settings/copy-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Menu, MenuRadioGroup, MenuRadioItem } from "@/components/ui/menu";
import { runChatPanel } from "@/lib/chat/client";
import { chatPanelSpec, type ShownPanel } from "@/lib/chat/panel";
import { PANEL_UNAVAILABLE } from "@/lib/chat/persist";
import type { ApiError } from "@/lib/errors";
import {
  EMPTY_TABLE_VIEW,
  initialView,
  type ViewSettings,
  viewChoices,
  viewPanel,
} from "@/lib/explore-view";
import { type QueryPanel, queryText, type TimeRange, VizType } from "@/lib/ir";
import type { QueryRows } from "@/lib/panel-query";
import { EMPTY_FILTERS, filterRows } from "@/lib/result-table";

/** A `showPanel` tool part, as the conversation streams or stores it. */
export interface ShowPanelPart {
  type: "tool-showPanel";
  toolCallId: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

/** "state-timeline" as "State timeline": a kind's name as the menu shows it. */
function vizLabel(viz: string): string {
  const words = viz.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Rows past which a table offers its filter box. */
const FILTER_FROM_ROWS = 10;

/**
 * One panel drawn in an answer (#416), through the same `PanelView` a
 * dashboard uses, so every registered kind can be an answer.
 *
 * The rows arrive on the stream the first time; after a reload they were
 * never stored, so the card asks the run route for them, which reads the spec
 * from the stored message. Show as redraws the same rows as another kind
 * without a model call, each candidate held to the IR's `Panel`.
 */
export function ChatPanelCard({
  conversationId,
  part,
  timeRange,
  refreshKey,
}: {
  conversationId: string | null;
  part: ShowPanelPart;
  /** The conversation's range: a change runs the panel again. */
  timeRange: TimeRange;
  /** Bumped to run every panel on screen again (live refresh). */
  refreshKey: number;
}) {
  if (part.state === "input-streaming" || part.state === "input-available") {
    return <DrawingCard input={part.input} />;
  }
  if (part.state === "output-error") {
    return <PanelNote>{part.errorText ?? PANEL_UNAVAILABLE}</PanelNote>;
  }
  const output = (part.output ?? {}) as Partial<ShownPanel> & { error?: string };
  if (output.ok !== true || typeof output.panelId !== "string") {
    return (
      <PanelNote>
        Couldn&rsquo;t draw this panel{output.error ? `: ${output.error}` : "."}
      </PanelNote>
    );
  }
  const spec = chatPanelSpec(part.input, output.panelId);
  if (!spec) return <PanelNote>{PANEL_UNAVAILABLE}</PanelNote>;
  return (
    <DrawnPanel
      conversationId={conversationId}
      spec={spec}
      streamed={
        Array.isArray(output.rows)
          ? {
              columns: output.columns ?? [],
              rows: output.rows,
              ...(output.window ? { window: output.window } : {}),
            }
          : null
      }
      timeRange={timeRange}
      refreshKey={refreshKey}
    />
  );
}

function DrawingCard({ input }: { input: unknown }) {
  const partial = (input ?? {}) as { title?: unknown; viz?: unknown };
  const viz = VizType.safeParse(partial.viz);
  return (
    <section
      aria-label={typeof partial.title === "string" ? partial.title : "Drawing a panel"}
      aria-busy
      className="flex h-64 flex-col border border-border bg-surface sm:h-80"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm text-muted">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        <span className="truncate">
          {typeof partial.title === "string" ? partial.title : "Drawing a panel…"}
        </span>
      </div>
      <div className="min-h-0 flex-1 p-3">
        <PanelSkeleton viz={viz.success ? viz.data : "table"} />
      </div>
    </section>
  );
}

function PanelNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 border border-border bg-surface-2/60 px-3 py-2 text-sm text-muted">
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

type Run =
  | { status: "loading" }
  | { status: "done"; rows: QueryRows; at: number }
  | { status: "error"; error: ApiError };

function DrawnPanel({
  conversationId,
  spec,
  streamed,
  timeRange,
  refreshKey,
}: {
  conversationId: string | null;
  spec: QueryPanel;
  streamed: QueryRows | null;
  timeRange: TimeRange;
  refreshKey: number;
}) {
  const [run, setRun] = React.useState<Run>(() =>
    streamed ? { status: "done", rows: streamed, at: Date.now() } : { status: "loading" },
  );
  const [refreshing, setRefreshing] = React.useState(false);
  const [view, setView] = React.useState<ViewSettings>(() => initialView(spec));
  const [filter, setFilter] = React.useState("");
  const latest = React.useRef(0);
  const filterId = React.useId();

  const rerun = React.useCallback(
    async (signal?: AbortSignal) => {
      if (!conversationId) return;
      const ticket = ++latest.current;
      setRefreshing(true);
      const result = await runChatPanel(conversationId, spec.id, { timeRange, signal });
      // A run that a newer one overtook, or that was abandoned, is dropped.
      if (ticket !== latest.current || signal?.aborted) return;
      setRefreshing(false);
      setRun(
        result.ok
          ? { status: "done", rows: result.value, at: Date.now() }
          : { status: "error", error: result.error },
      );
    },
    [conversationId, spec.id, timeRange],
  );

  // The first run when the rows did not arrive on the stream, and again when
  // the range or the refresh key changes. A streamed result is current for
  // the range it was drawn over, so the first pass leaves it.
  const first = React.useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is a deliberate re-run trigger
  React.useEffect(() => {
    if (first.current) {
      first.current = false;
      if (streamed) return;
    }
    const controller = new AbortController();
    void rerun(controller.signal);
    return () => controller.abort();
  }, [rerun, refreshKey]);

  const shown = viewPanel(spec, view, EMPTY_TABLE_VIEW) ?? spec;
  const choices = viewChoices(spec);
  const rows = run.status === "done" ? run.rows : null;
  const filtering = shown.viz === "table" && filter.trim() !== "";
  const data = rows
    ? {
        ...rows,
        rows: filtering
          ? filterRows(rows.rows, rows.columns, { ...EMPTY_FILTERS, text: filter })
          : rows.rows,
      }
    : { columns: [], rows: [] };
  const state: PanelState =
    run.status === "error"
      ? { data, status: "error", error: run.error }
      : run.status === "loading"
        ? { data, status: "loading" }
        : { data, status: "live", updatedAt: run.at };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="h-64 sm:h-80">
        <PanelView
          panel={shown}
          state={state}
          window={rows?.window}
          timeRange={timeRange}
          onRetry={() => void rerun()}
        />
      </div>
      <div className="flex flex-wrap items-center gap-1 text-xs">
        {choices.length > 1 && (
          <Menu
            label={`Show as: ${vizLabel(shown.viz)}`}
            className="h-7 gap-1.5 border border-border bg-surface px-2 text-xs text-foreground"
            trigger={
              <>
                <Eye className="h-3.5 w-3.5 text-muted" aria-hidden />
                <span>{vizLabel(shown.viz)}</span>
              </>
            }
          >
            <MenuRadioGroup
              label="Show as"
              value={view.viz}
              onValueChange={(viz) => setView((v) => ({ ...v, viz: viz as VizType }))}
            >
              {choices.map((viz) => (
                <MenuRadioItem key={viz} value={viz}>
                  {vizLabel(viz)}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </Menu>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          disabled={!conversationId || refreshing}
          onClick={() => void rerun()}
        >
          <RotateCcw
            className={refreshing ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"}
            aria-hidden
          />
          Re-run
        </Button>
        <CopyButton value={JSON.stringify(shown, null, 2)} label="Copy spec" />
        {shown.viz === "table" && rows && rows.rows.length > FILTER_FROM_ROWS && (
          <>
            <label htmlFor={filterId} className="sr-only">
              Filter rows of {spec.title}
            </label>
            <Input
              id={filterId}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter rows"
              className="h-7 w-40 text-xs"
            />
          </>
        )}
      </div>
      <QueryDetails panel={spec} timeRange={timeRange} />
    </div>
  );
}

/**
 * "Show query": the statement the panel runs, its source and the window the
 * server narrows it to, as a `<details>` under the card — the answer is what
 * is being read, and a modal over it is the wrong shape.
 */
function QueryDetails({ panel, timeRange }: { panel: QueryPanel; timeRange: TimeRange }) {
  const text = queryText(panel.query);
  return (
    <details className="border border-border bg-surface-2/60 text-xs">
      <summary className="flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-muted hover:text-foreground">
        <Database className="h-3 w-3 shrink-0" aria-hidden />
        Show query
      </summary>
      <div className="space-y-2 border-t border-border px-2.5 py-2">
        <p className="text-muted">
          Source <span className="font-mono text-foreground">{panel.query.sourceId}</span>
        </p>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
          {text}
        </pre>
        <p className="text-muted">
          The server narrows it to{" "}
          <span className="font-mono text-foreground">
            {timeRange.from} → {timeRange.to}
          </span>
          .
        </p>
        <CopyButton value={text} label="Copy query" />
      </div>
    </details>
  );
}
