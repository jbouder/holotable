"use client";

import * as React from "react";
import Link from "next/link";
import { History } from "lucide-react";
import { readRecent } from "@/lib/dashboard-list";
import type { DashboardSummary } from "@/lib/dashboard-metadata";

/**
 * The dashboards this browser opened most recently, newest first.
 *
 * The ids come from `localStorage` and the titles from
 * `GET /api/dashboards?id=…`, which is the same authorized, workspace-scoped
 * list query the page itself uses — so this strip can only ever show
 * dashboards the reader could have found anyway. Anything deleted, or in a
 * workspace they have since left, comes back missing and is dropped.
 *
 * It renders nothing at all until it has something to show, so a first-time
 * reader never sees an empty "Recent" heading.
 */
export function RecentDashboards() {
  const [recent, setRecent] = React.useState<DashboardSummary[]>([]);

  React.useEffect(() => {
    const ids = readRecent(window.localStorage);
    if (ids.length === 0) return;

    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`/api/dashboards?id=${ids.join(",")}`, {
          signal: controller.signal,
        });
        if (!res.ok) return;
        const { dashboards } = (await res.json()) as {
          dashboards: DashboardSummary[];
        };
        const byId = new Map(dashboards.map((d) => [d.id, d]));
        // Stored order is the answer to "recently", and the API's order is
        // not, so the rows are re-sorted into the order they were visited.
        setRecent(
          ids.flatMap((id) => {
            const found = byId.get(id);
            return found ? [found] : [];
          }),
        );
      } catch {
        /* A failed lookup just means no recent strip this load. */
      }
    })();

    return () => controller.abort();
  }, []);

  if (recent.length === 0) return null;

  return (
    <section className="mb-6">
      <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
        <History className="h-3.5 w-3.5" aria-hidden /> Recent
      </h2>
      <div className="flex flex-wrap gap-2">
        {recent.map((d) => (
          <Link
            key={d.id}
            href={`/dashboards/${d.id}`}
            className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground transition-colors hover:border-foreground/40 focus-visible:outline-2 focus-visible:outline-primary"
          >
            {d.title}
          </Link>
        ))}
      </div>
    </section>
  );
}
