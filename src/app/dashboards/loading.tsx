import { Skeleton } from "@/components/ui/skeleton";

/**
 * The dashboard list, before it arrives.
 *
 * The App Router's own suspense boundary: every page here is
 * `dynamic = "force-dynamic"` and reads the database, so a navigation used to
 * sit on the previous page until the query came back. The card grid below is
 * the same shape as the real one, so the page fills in rather than appearing
 * (#72).
 */
export default function Loading() {
  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-10 w-36" />
      </div>
      <Skeleton className="mb-6 h-10 w-full max-w-xl" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <Skeleton key={i} className="h-36 rounded-lg" />
        ))}
      </div>
      <span role="status" className="sr-only">
        Loading dashboards…
      </span>
    </div>
  );
}
