import { Skeleton } from "@/components/ui/skeleton";

/** The source list, before it arrives. See `app/dashboards/loading.tsx` (#72). */
export default function Loading() {
  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-10 w-32" />
      </div>
      <div className="space-y-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <span role="status" className="sr-only">
        Loading data sources…
      </span>
    </div>
  );
}
