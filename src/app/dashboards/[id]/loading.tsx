import { Skeleton } from "@/components/ui/skeleton";

/**
 * One dashboard, before the spec arrives.
 *
 * Only the header stands in. The panels' places are not known until the spec
 * is read, and a guessed grid of chart cards here was replaced a moment later
 * by `LiveDashboard`'s own skeletons in the real layout, so the page showed
 * two different grids in a row (#431). Each panel keeps its own skeleton until
 * its first frame (#72).
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
      <span role="status" className="sr-only">
        Loading dashboard…
      </span>
    </div>
  );
}
