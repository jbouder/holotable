"use client";

import * as React from "react";
import Link from "next/link";
import { History, Loader2, RotateCcw } from "lucide-react";
import type { Dashboard } from "@/lib/ir";
import type { ApiError } from "@/lib/errors";
import {
  authorLabel,
  diffDashboards,
  fetchVersion,
  fetchVersionPage,
  restoreVersion,
  type VersionDetail,
  type VersionPage,
  type VersionSummary,
} from "@/lib/dashboard-versions";
import { withViewTransition } from "@/lib/view-transition";
import { cn } from "@/lib/utils";
import { useReducedMotion } from "@/components/motion-preference";
import { LocalTime } from "@/components/time-display";
import { DashboardDiffView } from "@/components/dashboard/DashboardDiffView";
import { PreviewDashboard } from "@/components/dashboard/PreviewDashboard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ErrorDisplay } from "@/components/ui/error-display";
import { Skeleton } from "@/components/ui/skeleton";

type Tab = "changes" | "preview";

/**
 * The history list beside the selected version (#73).
 *
 * The diff runs from the selected version to the current one, forward in
 * time, so "added" means added since then. The preview is `PreviewDashboard`,
 * which runs each panel's query once through `/api/query` and has no save
 * path, so an old version can be looked at without being made current.
 */
export function VersionHistory({
  dashboardId,
  viewerSub,
  canRestore,
  current: initialCurrent,
  initialPage,
  initialSelected,
}: {
  dashboardId: string;
  viewerSub: string;
  canRestore: boolean;
  current: { version: number; spec: Dashboard };
  initialPage: VersionPage;
  initialSelected: number;
}) {
  const reducedMotion = useReducedMotion();
  const [current, setCurrent] = React.useState(initialCurrent);
  const [versions, setVersions] = React.useState(initialPage.versions);
  const [nextBefore, setNextBefore] = React.useState(initialPage.nextBefore);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [listError, setListError] = React.useState<ApiError | null>(null);

  const [selected, setSelected] = React.useState(initialSelected);
  const [details, setDetails] = React.useState<Record<number, VersionDetail>>({});
  const [detailError, setDetailError] = React.useState<ApiError | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  const [tab, setTab] = React.useState<Tab>("changes");

  const [confirming, setConfirming] = React.useState(false);
  const [restoring, setRestoring] = React.useState(false);
  const [restoreError, setRestoreError] = React.useState<ApiError | null>(null);
  const [restored, setRestored] = React.useState<{ from: number; to: number } | null>(
    null,
  );

  const isCurrent = selected === current.version;
  const spec = isCurrent ? current.spec : details[selected]?.spec;
  const row: VersionSummary | undefined =
    versions.find((v) => v.version === selected) ?? details[selected];

  // The current version's spec came with the page; any other is fetched once
  // and kept, so stepping back and forth through the list is free.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry trigger
  React.useEffect(() => {
    if (selected === current.version || details[selected]) return;
    let cancelled = false;
    setDetailError(null);
    void fetchVersion(dashboardId, selected).then((outcome) => {
      if (cancelled) return;
      if (outcome.ok) setDetails((d) => ({ ...d, [selected]: outcome.version }));
      else setDetailError(outcome.error);
    });
    return () => {
      cancelled = true;
    };
  }, [dashboardId, selected, current.version, details, attempt]);

  function select(version: number) {
    setSelected(version);
    setRestored(null);
    // `replaceState`, not a router navigation: the same route would re-render
    // the server page and reset this one's state for nothing.
    const url = new URL(window.location.href);
    url.searchParams.set("v", String(version));
    window.history.replaceState(null, "", url);
  }

  async function loadOlder() {
    if (nextBefore === null) return;
    setLoadingMore(true);
    setListError(null);
    const outcome = await fetchVersionPage(dashboardId, nextBefore);
    setLoadingMore(false);
    if (!outcome.ok) {
      setListError(outcome.error);
      return;
    }
    setVersions((v) => [...v, ...outcome.versions]);
    setNextBefore(outcome.nextBefore);
  }

  async function onRestore() {
    const target = details[selected];
    if (!target) return;
    setRestoring(true);
    setRestoreError(null);
    const outcome = await restoreVersion(dashboardId, selected);
    if (!outcome.ok) {
      setRestoreError(outcome.error);
      setRestoring(false);
      return;
    }
    setRestoring(false);
    setConfirming(false);
    setCurrent({ version: outcome.version, spec: target.spec });
    // The new row heads the list; the first page is re-read rather than
    // synthesized so its author and timestamp are the server's.
    const page = await fetchVersionPage(dashboardId, null);
    if (page.ok) {
      setVersions(page.versions);
      setNextBefore(page.nextBefore);
    } else {
      setListError(page.error);
    }
    select(outcome.version);
    setRestored({ from: target.version, to: outcome.version });
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <nav aria-label="Versions" className="space-y-2">
        <ul className="divide-y divide-border border border-border">
          {versions.map((v) => (
            <li key={v.version}>
              <button
                type="button"
                onClick={() => select(v.version)}
                aria-current={v.version === selected ? "true" : undefined}
                className={cn(
                  "w-full space-y-0.5 px-3 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-primary",
                  v.version === selected
                    ? "bg-surface-2"
                    : "hover:bg-surface-2/60 text-muted hover:text-foreground",
                )}
              >
                <span className="flex items-center gap-2">
                  <span className="font-mono text-sm text-foreground">v{v.version}</span>
                  {v.version === current.version && <Badge>current</Badge>}
                  <span className="ml-auto text-xs text-muted">
                    <LocalTime iso={v.createdAt} />
                  </span>
                </span>
                {v.note && (
                  <span className="block truncate text-xs text-foreground" title={v.note}>
                    {v.note}
                  </span>
                )}
                <span className="block text-xs text-muted" title={v.createdBy}>
                  {authorLabel(v.createdBy, viewerSub)} · {v.panelCount} panel
                  {v.panelCount === 1 ? "" : "s"}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {listError && (
          <ErrorDisplay
            error={listError}
            onRetry={() => void loadOlder()}
            disabled={loadingMore}
          />
        )}
        {nextBefore !== null && (
          <Button
            variant="secondary"
            size="sm"
            className="w-full"
            onClick={() => void loadOlder()}
            disabled={loadingMore}
          >
            {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
            Load older versions
          </Button>
        )}
      </nav>

      <section aria-labelledby="version-heading" className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="version-heading" className="text-lg font-semibold">
              v{selected}
              {isCurrent && <span className="text-muted"> (current)</span>}
            </h2>
            {row && (
              <p className="mt-0.5 text-xs text-muted">
                {row.note && <span className="text-foreground">{row.note} · </span>}
                <span title={row.createdBy}>{authorLabel(row.createdBy, viewerSub)}</span>
                {" · "}
                <LocalTime iso={row.createdAt} />
              </p>
            )}
          </div>
          {canRestore && !isCurrent && (
            <Button
              size="sm"
              onClick={() => {
                setRestoreError(null);
                setConfirming(true);
              }}
              disabled={!spec}
            >
              <RotateCcw className="h-4 w-4" /> Restore this version
            </Button>
          )}
        </div>

        {restored && (
          <p
            role="status"
            className="fade-in border border-border bg-surface px-3 py-2 text-sm"
          >
            Restored v{restored.from} as v{restored.to}.{" "}
            <Link
              href={`/dashboards/${dashboardId}`}
              className="text-primary underline-offset-2 hover:underline"
            >
              View the dashboard
            </Link>
          </p>
        )}

        <div
          className="flex w-fit border border-border bg-surface p-1"
          role="tablist"
          aria-label="Version view"
        >
          {(["changes", "preview"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              aria-controls={`version-${t}-panel`}
              id={`version-${t}-tab`}
              onClick={() => withViewTransition(() => setTab(t), !reducedMotion, "tab")}
              className={cn(
                "px-3 py-1.5 text-sm font-medium capitalize transition-colors",
                tab === t
                  ? "bg-surface-2 text-foreground"
                  : "text-muted hover:text-foreground",
              )}
            >
              {t}
            </button>
          ))}
        </div>

        <div
          role="tabpanel"
          id={`version-${tab}-panel`}
          aria-labelledby={`version-${tab}-tab`}
          className="tab-panel"
        >
          {detailError && !spec ? (
            <ErrorDisplay error={detailError} onRetry={() => setAttempt((n) => n + 1)} />
          ) : !spec ? (
            <div className="space-y-2" aria-busy="true">
              <Skeleton className="h-4 w-64" />
              <Skeleton className="h-32 w-full" />
              <span role="status" className="sr-only">
                Loading v{selected}…
              </span>
            </div>
          ) : tab === "changes" ? (
            isCurrent ? (
              <p className="flex items-center gap-2 text-sm text-muted">
                <History className="h-4 w-4" aria-hidden />
                This is the current version. Pick an earlier one to see what changed
                since.
              </p>
            ) : (
              <DashboardDiffView
                diff={diffDashboards(spec, current.spec)}
                fromLabel={`v${selected}`}
                toLabel={`v${current.version} (current)`}
              />
            )
          ) : (
            <PreviewDashboard spec={spec} />
          )}
        </div>
      </section>

      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          if (!restoring) setConfirming(open);
        }}
        title={`Restore v${selected}?`}
        className="max-w-lg"
      >
        <div className="space-y-4 text-sm">
          <p className="text-muted">
            This saves a copy of v{selected} as a new version and makes it current.
            Nothing is deleted: v{current.version} stays in the history and can be
            restored the same way.
          </p>
          <p className="text-muted">
            Every panel&apos;s query is checked again first, so a version that reads a
            source, table or column that has since been removed or hidden is refused.
          </p>
          {restoreError && <ErrorDisplay error={restoreError} />}
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => setConfirming(false)}
              disabled={restoring}
            >
              Cancel
            </Button>
            <Button onClick={() => void onRestore()} disabled={restoring}>
              {restoring ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RotateCcw className="h-4 w-4" />
              )}
              Restore v{selected}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
