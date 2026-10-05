import type { Annotation } from "@/lib/annotations";
import type { AnnotationStore } from "@/lib/db/annotations";
import { type Dashboard, hasQuery, type TimeRange } from "@/lib/ir";
import { resolveTimeRange } from "@/lib/time";

/**
 * Which annotations a dashboard is shown (#68), on the server.
 *
 * The workspace is the dashboard record's own, never a request field, so a
 * dashboard can only ever show its own workspace's annotations. The window is
 * resolved here, like every window (invariant 8): the one the viewer is
 * looking at, widened to cover any panel with a window of its own (#114), so
 * that panel's markers are there too.
 */
export async function dashboardAnnotations(input: {
  dashboard: { workspaceId: string; spec: Dashboard };
  /** The window the viewer picked; the dashboard's own when they did not. */
  shown: TimeRange;
  store: AnnotationStore;
  now?: Date;
}): Promise<Annotation[]> {
  const { dashboard, store } = input;
  const settings = dashboard.spec.annotations;
  if (settings?.show === false) return [];
  const window = annotationWindow(dashboard.spec, input.shown, input.now);
  return store.list({
    workspaceId: dashboard.workspaceId,
    from: window.from,
    to: window.to,
    tags: settings?.tags,
  });
}

/** The span every panel of the dashboard is drawn over. Throws `TimeRangeError`. */
export function annotationWindow(
  spec: Dashboard,
  shown: TimeRange,
  now: Date = new Date(),
): { from: Date; to: Date } {
  const windows = [
    resolveTimeRange(shown, now),
    ...spec.panels.filter(hasQuery).flatMap((p) => {
      if (!p.timeRange) return [];
      try {
        return [resolveTimeRange(p.timeRange, now)];
      } catch {
        // That panel reports its own window's failure; it widens nothing.
        return [];
      }
    }),
  ];
  return {
    from: new Date(Math.min(...windows.map((w) => w.from.getTime()))),
    to: new Date(Math.max(...windows.map((w) => w.to.getTime()))),
  };
}
