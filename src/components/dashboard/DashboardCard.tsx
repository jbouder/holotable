"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Copy, Loader2, MoreVertical, Star, Tag, Trash2, Pencil } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/menu";
import { ErrorDisplay } from "@/components/ui/error-display";
import { type ApiError, readApiError } from "@/lib/errors";
import type { DashboardSummary } from "@/lib/dashboard-metadata";
import { dashboardListHref, EMPTY_QUERY } from "@/lib/dashboard-list";
import { cn } from "@/lib/utils";
import { DashboardDetailsDialog } from "./DashboardDetailsDialog";

/**
 * One dashboard in the list: what it is, how to get to it, and the three
 * things you can do to it without opening it.
 *
 * The card is a client component only because of those three — the list around
 * it is still server-rendered from an authorized, filtered query. Every action
 * is re-authorized by the API it calls; `canEdit` and `canDelete` decide what
 * is *shown*, never what is allowed.
 */
export function DashboardCard({
  dashboard,
  canEdit,
  canDelete,
  tagSuggestions = [],
}: {
  dashboard: DashboardSummary;
  canEdit: boolean;
  canDelete: boolean;
  tagSuggestions?: string[];
}) {
  const router = useRouter();
  const [details, setDetails] = React.useState(false);
  const [favorite, setFavorite] = React.useState(dashboard.favorite);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);

  async function toggleFavorite() {
    // Optimistic: a star that waits for a round trip feels broken, and the
    // only cost of being wrong is the revert below.
    const next = !favorite;
    setFavorite(next);
    setError(null);
    const res = await fetch(`/api/dashboards/${dashboard.id}/favorite`, {
      method: next ? "PUT" : "DELETE",
    });
    if (!res.ok) {
      setFavorite(!next);
      setError(await readApiError(res));
      return;
    }
    router.refresh();
  }

  async function duplicate() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/dashboards/${dashboard.id}/duplicate`, {
      method: "POST",
    });
    if (!res.ok) {
      setError(await readApiError(res));
      setBusy(false);
      return;
    }
    const { dashboard: copy } = (await res.json()) as { dashboard: { id: string } };
    // Straight into the copy: duplicating is always the first half of
    // "…and then change it".
    router.push(`/dashboards/${copy.id}/edit`);
  }

  async function remove() {
    if (!window.confirm(`Delete "${dashboard.title}"? This cannot be undone.`)) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/dashboards/${dashboard.id}`, { method: "DELETE" });
    if (!res.ok) {
      setError(await readApiError(res));
      setBusy(false);
      return;
    }
    router.refresh();
  }

  return (
    <Card className="relative h-full transition-colors hover:border-foreground/40">
      <CardContent className="flex h-full flex-col gap-2">
        <div className="flex items-start justify-between gap-1">
          {/*
            The link is stretched over the whole card rather than wrapping it,
            so the star and the menu are siblings of it instead of buttons
            nested inside an anchor.
          */}
          <Link
            href={`/dashboards/${dashboard.id}`}
            className="font-medium leading-snug after:absolute after:inset-0 after:content-[''] focus-visible:outline-2 focus-visible:outline-primary"
          >
            {dashboard.title}
          </Link>
          <div className="relative flex shrink-0 items-center">
            <button
              type="button"
              onClick={toggleFavorite}
              aria-pressed={favorite}
              aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
              title={favorite ? "Remove from favorites" : "Add to favorites"}
              className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded text-muted transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
            >
              <Star className={cn("h-4 w-4", favorite && "fill-primary text-primary")} />
            </button>
            {(canEdit || canDelete) && (
              <Menu
                label={`Actions for ${dashboard.title}`}
                trigger={
                  busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <MoreVertical className="h-4 w-4" />
                  )
                }
              >
                {canEdit && (
                  <>
                    <MenuItem onClick={() => setDetails(true)}>
                      <Pencil className="h-4 w-4" /> Details…
                    </MenuItem>
                    <MenuItem onClick={() => void duplicate()} disabled={busy}>
                      <Copy className="h-4 w-4" /> Duplicate
                    </MenuItem>
                  </>
                )}
                {canDelete && (
                  <>
                    {canEdit && <MenuSeparator />}
                    <MenuItem danger onClick={() => void remove()} disabled={busy}>
                      <Trash2 className="h-4 w-4" /> Delete
                    </MenuItem>
                  </>
                )}
              </Menu>
            )}
          </div>
        </div>

        {dashboard.description && (
          <p className="line-clamp-2 text-xs text-muted">{dashboard.description}</p>
        )}

        {dashboard.tags.length > 0 && (
          <div className="relative flex flex-wrap gap-1">
            {/*
              A tag is a link to the list filtered by it, not a callback: the
              card is rendered from a server component, and the filtered list
              is a URL anyway.
            */}
            {dashboard.tags.map((tag) => (
              <Link
                key={tag}
                href={dashboardListHref({ ...EMPTY_QUERY, tags: [tag] })}
                className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted transition-colors hover:border-primary/50 hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
              >
                <Tag className="h-2.5 w-2.5" aria-hidden /> {tag}
              </Link>
            ))}
          </div>
        )}

        <div className="mt-auto flex flex-col gap-0.5 text-xs text-muted">
          <span>
            {dashboard.workspaceId} · v{dashboard.version}
          </span>
          <span>updated {new Date(dashboard.updatedAt).toLocaleString()}</span>
        </div>

        {error && (
          <ErrorDisplay error={error} className="relative z-10 mt-1 w-full text-xs" />
        )}
      </CardContent>

      {canEdit && (
        <DashboardDetailsDialog
          dashboardId={dashboard.id}
          initial={{
            title: dashboard.title,
            description: dashboard.description,
            tags: dashboard.tags,
          }}
          suggestions={tagSuggestions}
          open={details}
          onOpenChange={setDetails}
          onSaved={() => router.refresh()}
        />
      )}
    </Card>
  );
}
