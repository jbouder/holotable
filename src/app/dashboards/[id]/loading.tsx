import { PanelCardSkeleton } from "@/components/dashboard/PanelSkeleton";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * One dashboard, before the spec arrives.
 *
 * The panel count is not knowable until the row is read, so this stands in
 * with a plausible two-up arrangement rather than an empty page; the moment
 * the spec lands, `LiveDashboard` takes over and each panel keeps its own
 * skeleton until its first frame (#72).
 */
export default function Loading() {
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-3 w-80 max-w-full" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-28" />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <PanelCardSkeleton key={i} className="h-64" />
        ))}
      </div>
      <span role="status" className="sr-only">
        Loading dashboard…
      </span>
    </div>
  );
}
