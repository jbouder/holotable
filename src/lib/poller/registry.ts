import type { Dashboard, Panel } from "@/lib/ir";
import { getSourceById } from "@/lib/db/repo";
import type { SourceRecord } from "@/lib/registry";
import { validateSql, buildExecutablePlan } from "@/lib/sql/safety";
import { resolveTimeRange } from "@/lib/time";
import { executePlan } from "@/lib/timescaledb/client";
import { config } from "@/lib/config";

/**
 * Shared in-process dashboard poller.
 *
 * INVARIANT: exactly ONE poller runs per dashboard, shared across all
 * independently-authorized subscribers. Each subscriber opens ONE EventSource;
 * the poller executes each panel query once per tick and broadcasts deltas.
 *
 * Delta cursors: for time-series panels the poller tracks the last emitted
 * timestamp per panel and only sends newer rows ("append"); the browser merges
 * them into a bounded rolling window via ECharts setOption (no chart
 * recreation). Non-time panels are sent as full "replace" snapshots.
 *
 * The metrics source is re-resolved and re-checked (tombstone) on EVERY tick,
 * so referenced-but-removed sources surface as tombstone events.
 *
 * CAVEAT: this poller is per-process. Running multiple app instances would
 * create one poller per instance. See docs/ARCHITECTURE.md (single-instance
 * poller caveat) for the horizontal-scaling note.
 */

export type PollerEvent =
  | {
      type: "panel";
      panelId: string;
      mode: "append" | "replace";
      columns: string[];
      rows: Record<string, unknown>[];
    }
  | { type: "panel-error"; panelId: string; error: string }
  | { type: "tombstone"; panelId: string; sourceId: string }
  | { type: "tick"; at: number };

type Listener = (event: PollerEvent) => void;

export interface TimeWindow {
  from: Date;
  to: Date;
}

/**
 * Pure delta computation. Given the full result of a query and the previous
 * cursor, returns only the newer rows and the advanced cursor. Exported for
 * unit testing.
 */
export function computeDelta(
  rows: Record<string, unknown>[],
  timeField: string,
  prevCursor: string | undefined,
): {
  fresh: Record<string, unknown>[];
  cursor: string | undefined;
  mode: "append" | "replace";
} {
  const fresh = prevCursor
    ? rows.filter((r) => String(r[timeField]) > prevCursor)
    : rows;
  const cursor = rows.reduce<string | undefined>((acc, r) => {
    const v = String(r[timeField]);
    return acc === undefined || v > acc ? v : acc;
  }, prevCursor);
  return { fresh, cursor, mode: prevCursor ? "append" : "replace" };
}

/**
 * Executes a single panel and returns the events to broadcast.
 *
 * `dashboardWorkspaceId` is the trusted workspace identity resolved from the
 * dashboard record at poller-creation time. Every execution MUST verify that
 * the resolved source belongs to that workspace; a crafted jsonb spec that
 * names a cross-workspace sourceId is surfaced as a tombstone (indistinguishable
 * from a deleted source to prevent information disclosure).
 */
export type PanelExecutor = (
  panel: Panel,
  window: TimeWindow,
  cursors: Map<string, string>,
  dashboardWorkspaceId: string,
) => Promise<PollerEvent[]>;

/**
 * Factory that creates a PanelExecutor with an injectable source resolver.
 * Pass a mock resolver in tests to exercise workspace-isolation logic without
 * a live database.
 */
export function makePanelExecutor(
  getSource: (id: string) => Promise<SourceRecord | null> = getSourceById,
): PanelExecutor {
  return async (panel, window, cursors, dashboardWorkspaceId) => {
    // Re-resolve the source on every execution.
    const source = await getSource(panel.query.sourceId);

    // Tombstoned, missing, and cross-workspace sources all surface identically
    // as tombstone events so callers cannot distinguish "deleted" from "not
    // yours" — this is the single mandatory workspace-isolation enforcement
    // point for the shared poller.
    if (
      !source ||
      source.tombstonedAt ||
      source.workspaceId !== dashboardWorkspaceId
    ) {
      return [
        { type: "tombstone", panelId: panel.id, sourceId: panel.query.sourceId },
      ];
    }

    const check = validateSql(panel.query.sql, source.config);
    if (!check.ok) {
      return [
        { type: "panel-error", panelId: panel.id, error: check.error ?? "invalid sql" },
      ];
    }

    const plan = buildExecutablePlan({
      sql: panel.query.sql,
      timeField: panel.query.timeField,
      from: window.from,
      to: window.to,
    });
    const result = await executePlan(source, plan);

    if (panel.query.timeField) {
      const delta = computeDelta(
        result.rows,
        panel.query.timeField,
        cursors.get(panel.id),
      );
      if (delta.cursor !== undefined) cursors.set(panel.id, delta.cursor);
      return [
        {
          type: "panel",
          panelId: panel.id,
          mode: delta.mode,
          columns: result.columns,
          rows: delta.fresh,
        },
      ];
    }

    return [
      {
        type: "panel",
        panelId: panel.id,
        mode: "replace",
        columns: result.columns,
        rows: result.rows,
      },
    ];
  };
}

/** Default executor used in production. */
export const defaultPanelExecutor: PanelExecutor = makePanelExecutor();

class DashboardPoller {
  private listeners = new Set<Listener>();
  private cursors = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    readonly dashboardId: string,
    readonly version: number,
    readonly dashboardWorkspaceId: string,
    private spec: Dashboard,
    private executor: PanelExecutor = defaultPanelExecutor,
  ) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    if (!this.running) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  get isRunning(): boolean {
    return this.running;
  }

  private start() {
    this.running = true;
    void this.tick();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const [key, poller] of registry) {
      if (poller === this) {
        registry.delete(key);
        break;
      }
    }
  }

  private broadcast(event: PollerEvent) {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        /* listener errors must not break the loop */
      }
    }
  }

  private scheduleNext() {
    if (!this.running || this.listeners.size === 0) return;
    const interval = Math.max(
      config.minRefreshIntervalMs,
      this.spec.refreshIntervalMs,
    );
    this.timer = setTimeout(() => void this.tick(), interval);
  }

  private async tick() {
    if (!this.running) return;
    const window = resolveTimeRange(this.spec.timeRange);
    await Promise.all(
      this.spec.panels.map(async (p) => {
        try {
          const events = await this.executor(p, window, this.cursors, this.dashboardWorkspaceId);
          for (const e of events) this.broadcast(e);
        } catch (err) {
          this.broadcast({
            type: "panel-error",
            panelId: p.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
    this.broadcast({ type: "tick", at: Date.now() });
    this.scheduleNext();
  }
}

const registry = new Map<string, DashboardPoller>();

/**
 * Get the shared poller for a dashboard and time range, creating it if needed.
 * If a poller exists for an older version, it is replaced so the new spec takes
 * effect. Distinct viewer-selected ranges are isolated from each other.
 *
 * `workspaceId` is the trusted dashboard workspace identity resolved from the
 * database record. It is stored on the poller and passed to every panel
 * execution so sources are always validated against the dashboard workspace,
 * regardless of subscriber identity.
 */
export function getPoller(
  dashboardId: string,
  version: number,
  workspaceId: string,
  spec: Dashboard,
  executor: PanelExecutor = defaultPanelExecutor,
): DashboardPoller {
  const key = JSON.stringify([dashboardId, spec.timeRange.from, spec.timeRange.to]);
  const existing = registry.get(key);
  if (existing && existing.version >= version) return existing;
  if (existing) existing.stop();
  const poller = new DashboardPoller(dashboardId, version, workspaceId, spec, executor);
  registry.set(key, poller);
  return poller;
}

/** Drop a poller (e.g. after a new version is saved). */
export function invalidatePoller(dashboardId: string): void {
  for (const poller of registry.values()) {
    if (poller.dashboardId === dashboardId) poller.stop();
  }
}

/** Test/introspection helper. */
export function activePollerCount(): number {
  return registry.size;
}

export { DashboardPoller };
