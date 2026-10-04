"use client";

import * as React from "react";
import { ChevronRight, Clock, Loader2, RefreshCw, Search } from "lucide-react";
import {
  type CatalogView,
  fetchCatalogView,
  searchCatalog,
  updateColumnExposure,
} from "@/lib/catalog/browse";
import { type CatalogHealth, describeCatalogHealth } from "@/lib/catalog/health";
import { summarizeCatalogDiff } from "@/lib/catalog/refresh";
import type { ApiError } from "@/lib/errors";
import { type CatalogColumn, type CatalogTable, isExposed } from "@/lib/registry";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { ErrorDisplay } from "@/components/ui/error-display";
import { Input } from "@/components/ui/input";
import { CatalogHealthBadge } from "@/components/sources/catalog-health";
import { LocalTime } from "@/components/time-display";
import {
  CatalogRefreshReview,
  type RefreshApplied,
} from "@/components/sources/catalog-refresh";

/**
 * One source's catalog as a tree: tables, then columns with their types (#123).
 *
 * The server decides what each caller sees (`catalogView`). An admin gets every
 * column with an inline **Exposed** toggle and a Refresh that reviews its diff
 * in place. Anyone else gets the exposed columns only, read-only. The
 * freshness sentence at the top is the same one the source pickers show.
 */

type Named = { id: string; name: string };

export function CatalogBrowserDialog({
  source,
  onClose,
  onChanged,
}: {
  /** The source being browsed; null keeps the dialog closed. */
  source: Named | null;
  onClose: () => void;
  /** After a refresh or a toggle, with the source's health as it now stands. */
  onChanged?: (sourceId: string, health: CatalogHealth) => void;
}) {
  return (
    <Dialog
      open={source !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={source ? `Catalog: ${source.name}` : "Catalog"}
    >
      {source && (
        <CatalogBrowser
          key={source.id}
          source={source}
          onChanged={(health) => onChanged?.(source.id, health)}
        />
      )}
    </Dialog>
  );
}

type Load =
  | { state: "loading" }
  | { state: "failed"; error: ApiError }
  | { state: "ready"; view: CatalogView };

export function CatalogBrowser({
  source,
  onChanged,
}: {
  source: Named;
  onChanged?: (health: CatalogHealth) => void;
}) {
  const [load, setLoad] = React.useState<Load>({ state: "loading" });
  const [query, setQuery] = React.useState("");
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(new Set());
  const [refreshing, setRefreshing] = React.useState(false);
  // The column whose toggle is in flight, as `table.column`.
  const [pending, setPending] = React.useState<string | null>(null);
  const [toggleError, setToggleError] = React.useState<ApiError | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    const result = await fetchCatalogView(source.id);
    setLoad(
      result.ok
        ? { state: "ready", view: result.view }
        : { state: "failed", error: result.error },
    );
  }, [source.id]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  if (load.state === "loading") {
    return (
      <p className="flex items-center gap-2 text-sm text-muted" role="status">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading the catalog…
      </p>
    );
  }
  if (load.state === "failed") {
    return (
      <ErrorDisplay
        error={load.error}
        onRetry={() => void reload()}
        retryLabel="Try again"
      />
    );
  }

  const { view } = load;

  if (refreshing) {
    return (
      <CatalogRefreshReview
        sourceId={source.id}
        onCancel={() => setRefreshing(false)}
        onApplied={(result: RefreshApplied) => {
          setRefreshing(false);
          setNotice(`Catalog refreshed. ${summarizeCatalogDiff(result.diff)}`);
          onChanged?.(result.catalogHealth);
          void reload();
        }}
      />
    );
  }

  async function toggle(table: string, column: string, exposed: boolean) {
    setPending(`${table}.${column}`);
    setToggleError(null);
    setNotice(null);
    const result = await updateColumnExposure(source.id, { table, column, exposed });
    setPending(null);
    if (!result.ok) {
      setToggleError(result.error);
      return;
    }
    setLoad({ state: "ready", view: result.view });
    setNotice(
      exposed
        ? `${table}.${column} is exposed. Generated SQL may read it again.`
        : `${table}.${column} is hidden. The model is no longer told about it, and SQL that reads it is refused.`,
    );
    onChanged?.(result.view.catalogHealth);
  }

  const matches = searchCatalog(view.tables, query);
  const searching = query.trim() !== "";
  const missing = new Set(view.missingTables);

  return (
    <div className="space-y-4">
      <Freshness source={source} view={view} onRefresh={() => setRefreshing(true)} />

      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
          aria-hidden
        />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tables, columns and types"
          aria-label="Search the catalog"
          className="pl-9"
        />
      </div>

      {notice && (
        <p className="drop-in text-xs text-muted" role="status">
          {notice}
        </p>
      )}
      {toggleError && <ErrorDisplay error={toggleError} />}

      {matches.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">
          {searching ? `Nothing in the catalog matches “${query.trim()}”.` : "No tables."}
        </p>
      ) : (
        <ul className="divide-y divide-border border border-border">
          {matches.map(({ table, columns }) => (
            <TableNode
              key={table.name}
              table={table}
              columns={columns}
              open={searching || expanded.has(table.name)}
              missing={missing.has(table.name)}
              canManage={view.canManage}
              pending={pending}
              onToggleOpen={() =>
                setExpanded((prev) => {
                  const next = new Set(prev);
                  if (next.has(table.name)) next.delete(table.name);
                  else next.add(table.name);
                  return next;
                })
              }
              onToggleExposed={(column, exposed) =>
                void toggle(table.name, column, exposed)
              }
            />
          ))}
        </ul>
      )}

      {!view.canManage && (
        <p className="text-xs text-muted">
          Read-only. A source admin for this workspace can refresh the catalog and choose
          which columns are exposed.
        </p>
      )}
    </div>
  );
}

function Freshness({
  source,
  view,
  onRefresh,
}: {
  source: Named;
  view: CatalogView;
  onRefresh: () => void;
}) {
  const health = view.catalogHealth;
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border border-border bg-surface-2/40 px-3 py-2">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <CatalogHealthBadge source={source} health={health} />
          <span className="text-muted">
            {health.refreshedAt ? (
              <>
                Last refreshed <LocalTime iso={health.refreshedAt} />
              </>
            ) : (
              "Never refreshed"
            )}
          </span>
          <span className="text-muted">schema {view.schema}</span>
        </div>
        {health.state !== "ok" && (
          <p className="text-xs text-muted">{describeCatalogHealth(source, health)}</p>
        )}
      </div>
      {view.canManage && (
        <Button variant="ghost" size="sm" onClick={onRefresh}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
      )}
    </div>
  );
}

function TableNode({
  table,
  columns,
  open,
  missing,
  canManage,
  pending,
  onToggleOpen,
  onToggleExposed,
}: {
  table: CatalogTable;
  columns: CatalogColumn[];
  open: boolean;
  missing: boolean;
  canManage: boolean;
  pending: string | null;
  onToggleOpen: () => void;
  onToggleExposed: (column: string, exposed: boolean) => void;
}) {
  const panelId = React.useId();
  const hidden = table.columns.filter((c) => !isExposed(c)).length;

  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggleOpen}
        className="flex w-full cursor-pointer items-start gap-2 px-3 py-2 text-left transition-colors duration-(--duration-fast) ease-standard hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-primary"
      >
        <ChevronRight
          className={cn(
            "mt-0.5 h-4 w-4 shrink-0 text-muted transition-transform duration-(--duration-fast) ease-standard",
            open && "rotate-90",
          )}
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-medium text-foreground">
              {table.name}
            </span>
            <span className="text-xs text-muted">
              {table.columns.length} column{table.columns.length === 1 ? "" : "s"}
            </span>
            {canManage && hidden > 0 && <Badge>{hidden} hidden</Badge>}
            {missing && (
              <span className="border border-danger/40 px-1.5 text-[11px] text-danger">
                not found at last refresh
              </span>
            )}
          </span>
          {table.description && (
            <span className="block text-xs text-muted">{table.description}</span>
          )}
        </span>
      </button>
      {open && (
        <ul id={panelId} className="fade-in border-t border-border bg-surface-2/30 py-1">
          {columns.map((column) => {
            const exposed = isExposed(column);
            const key = `${table.name}.${column.name}`;
            const isTime = table.timeField === column.name;
            return (
              <li
                key={column.name}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1 pl-9 pr-3"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span
                      className={cn(
                        "font-mono text-xs",
                        exposed ? "text-foreground" : "text-muted line-through",
                      )}
                    >
                      {column.name}
                    </span>
                    <span className="font-mono text-xs text-muted">{column.type}</span>
                    {isTime && (
                      <span className="inline-flex items-center gap-1 text-[11px] text-primary">
                        <Clock className="h-3 w-3" aria-hidden /> time field
                      </span>
                    )}
                  </span>
                  {column.description && (
                    <span className="block text-xs text-muted">{column.description}</span>
                  )}
                </span>
                {canManage && (
                  <Checkbox
                    checked={exposed}
                    disabled={pending !== null}
                    onCheckedChange={(next) => onToggleExposed(column.name, next)}
                    label={
                      <span className="text-xs text-muted">
                        {pending === key ? "Saving…" : "Exposed"}
                      </span>
                    }
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}
