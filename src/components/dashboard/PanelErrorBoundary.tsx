"use client";

import * as React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import type { Panel } from "@/lib/ir";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Per-panel render backstop.
 *
 * `PanelView` already handles every *data* failure — error, stale, tombstoned
 * all render as a card. What it cannot handle is a *render* failure: a
 * malformed row reaching `buildChartOption()`, an option ECharts rejects, a
 * throw inside `StatView` or `TableView`. React unwinds to the nearest
 * boundary, and without one that is the route, so a single bad panel blanks
 * the whole dashboard while every other panel was streaming fine.
 *
 * This is the boundary. It renders the same `Card` chrome as `PanelView` so a
 * broken panel keeps its place in the grid, and its Retry remounts the subtree
 * by bumping a key — the panel's own poller state is untouched, so the next
 * frame repaints it.
 *
 * Error boundaries are still class components in React 19; there is no hook
 * equivalent.
 */

export interface PanelErrorReport {
  panelId: string;
  /** Viz type, which is usually the first thing that narrows a render bug. */
  viz: Panel["viz"];
  error: Error;
  componentStack?: string;
}

interface Props {
  panel: Panel;
  children: React.ReactNode;
  /**
   * Called once per caught error. Deliberately a prop rather than a direct
   * call into a reporting client: shipping errors off the browser is #55, and
   * this component should not grow a transport. `src/lib/log.ts` is
   * server-only (`node:async_hooks`), so there is nothing to log to here yet.
   */
  onError?: (report: PanelErrorReport) => void;
}

interface State {
  error: Error | null;
  /** Bumped on retry to remount the children rather than reuse a broken tree. */
  attempt: number;
}

export class PanelErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    this.props.onError?.({
      panelId: this.props.panel.id,
      viz: this.props.panel.viz,
      error,
      componentStack: info.componentStack ?? undefined,
    });
  }

  private readonly retry = () => {
    this.setState((s) => ({ error: null, attempt: s.attempt + 1 }));
  };

  render() {
    const { error, attempt } = this.state;
    if (error) {
      return (
        <PanelRenderErrorCard
          panel={this.props.panel}
          error={error}
          onRetry={this.retry}
        />
      );
    }
    return <React.Fragment key={attempt}>{this.props.children}</React.Fragment>;
  }
}

/**
 * The fallback card. Split out from the boundary so it can be rendered — and
 * tested — without provoking a real unwind.
 */
export function PanelRenderErrorCard({
  panel,
  error,
  onRetry,
}: {
  panel: Panel;
  error: Error;
  onRetry?: () => void;
}) {
  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <CardTitle className="min-w-0 truncate">{panel.title}</CardTitle>
        <span className="shrink-0 bg-danger/20 px-2 py-0.5 text-xs font-medium text-danger">
          Render error
        </span>
      </CardHeader>
      <CardContent className="flex-1 min-h-0">
        <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted">
          <AlertTriangle className="h-5 w-5 text-danger" />
          <span className="line-clamp-3 break-words">
            {error.message || "This panel failed to render."}
          </span>
          {onRetry && (
            <Button variant="secondary" size="sm" className="mt-1" onClick={onRetry}>
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
