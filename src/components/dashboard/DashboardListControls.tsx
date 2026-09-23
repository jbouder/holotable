"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Search, Star, X } from "lucide-react";
import { Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button, ButtonLabel } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  type DashboardQuery,
  type DashboardSort,
  dashboardListHref,
  isFiltered,
  type ListDefaults,
  toggleTag,
} from "@/lib/dashboard-list";

const SORTS: { value: DashboardSort; label: string }[] = [
  { value: "updated", label: "Recently updated" },
  { value: "created", label: "Recently created" },
  { value: "title", label: "Name" },
];

/**
 * The list's filter bar.
 *
 * It holds no results and does no filtering: every control rewrites the URL,
 * and the server page re-renders the list from the database for that URL. That
 * is what keeps the list correct past one page — filtering client-side would
 * quietly mean "filter the twenty-four rows that happen to be loaded" — and it
 * is what makes a filtered list a link someone can send.
 */
export function DashboardListControls({
  query,
  tags,
  defaults,
}: {
  query: DashboardQuery;
  tags: { tag: string; count: number }[];
  /** The reader's saved list defaults, which the URL leaves out. */
  defaults?: ListDefaults;
}) {
  const router = useRouter();
  const [search, setSearch] = React.useState(query.search);

  // The URL follows what has been typed, once typing pauses: a navigation per
  // keystroke would put every prefix of the word in the back button.
  React.useEffect(() => {
    if (search === query.search) return;
    const timer = setTimeout(() => {
      router.replace(dashboardListHref({ ...query, search, page: 1 }, defaults));
    }, 250);
    return () => clearTimeout(timer);
  }, [search, query, router, defaults]);

  // A back/forward navigation changes the query under us; the box follows it.
  React.useEffect(() => setSearch(query.search), [query.search]);

  const go = (next: DashboardQuery) => router.replace(dashboardListHref(next, defaults));

  return (
    <div className="mb-4 flex flex-col gap-3">
      {/*
        One row at every width. The search takes whatever the controls leave
        and the sort control sits at the right edge; on a phone the search
        shrinks instead of the sort wrapping below it (`min-w-0` lets the
        input go narrower than its intrinsic width).
      */}
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
            aria-hidden
          />
          <Input
            aria-label="Search dashboards"
            placeholder="Search by name or description…"
            value={search}
            className="pl-9"
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {isFiltered(query) && (
          <Button
            variant="ghost"
            size="sm"
            collapse
            title="Clear filters"
            className="shrink-0"
            onClick={() =>
              go({ ...query, search: "", tags: [], favorites: false, page: 1 })
            }
          >
            <X className="h-4 w-4" /> <ButtonLabel>Clear</ButtonLabel>
          </Button>
        )}
        <Button
          variant={query.favorites ? "secondary" : "ghost"}
          size="sm"
          collapse
          aria-pressed={query.favorites}
          title="Show only starred dashboards"
          className="shrink-0"
          onClick={() => go({ ...query, favorites: !query.favorites, page: 1 })}
        >
          <Star className={cn("h-4 w-4", query.favorites && "fill-current")} />{" "}
          <ButtonLabel>Favorites</ButtonLabel>
        </Button>
        <Label htmlFor="dashboard-sort" className="sr-only">
          Sort dashboards
        </Label>
        <Select
          id="dashboard-sort"
          className="shrink-0"
          value={query.sort}
          options={SORTS}
          onValueChange={(value) =>
            go({ ...query, sort: value as DashboardSort, page: 1 })
          }
        />
      </div>

      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tags.map(({ tag, count }) => {
            const active = query.tags.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                aria-pressed={active}
                onClick={() => go(toggleTag(query, tag))}
                className={cn(
                  "inline-flex cursor-pointer items-center gap-1.5 border px-2.5 py-0.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-primary",
                  active
                    ? "border-primary/60 bg-primary/10 text-foreground"
                    : "border-border text-muted hover:border-foreground/40 hover:text-foreground",
                )}
              >
                {tag}
                <span className="text-[10px] opacity-70">{count}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
