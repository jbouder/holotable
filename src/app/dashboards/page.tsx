import type { ReactNode } from "react";
import Link from "next/link";
import { cookies } from "next/headers";
import { Plus, SearchX, Star } from "lucide-react";
import { authorizedWorkspaces, can, getIdentity } from "@/lib/auth/authorize";
import { accessibleWorkspaces, type Identity } from "@/lib/auth/claims";
import { listDashboardTags, listDashboards, listSources } from "@/lib/db/repo";
import type { DashboardSummary } from "@/lib/dashboard-metadata";
import {
  dashboardListHref,
  isFiltered,
  PAGE_SIZE,
  pageCount,
  pageOffset,
  parseDashboardQuery,
} from "@/lib/dashboard-list";
import { catalogHealth } from "@/lib/catalog/health";
import { onboardingState } from "@/lib/onboarding";
import { isDismissed, SETUP_DISMISSED_COOKIE } from "@/lib/dismissals";
import type { ImportTarget } from "@/lib/dashboard-export";
import { SignIn } from "@/components/sign-in";
import { FirstRun } from "@/components/onboarding/first-run";
import { DashboardCard } from "@/components/dashboard/DashboardCard";
import { DashboardListControls } from "@/components/dashboard/DashboardListControls";
import { RecentDashboards } from "@/components/dashboard/RecentDashboards";
import { ImportDashboard } from "./import-dashboard";
import { Button, ButtonLabel } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export const dynamic = "force-dynamic";

export default async function DashboardsPage({
  searchParams,
}: {
  /** The whole list state — search, tags, sort, page — lives in the URL. */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const identity = await getIdentity();
  if (!identity) return <SignIn />;

  const query = parseDashboardQuery(await searchParams);
  const workspaces = accessibleWorkspaces(identity);
  const editable = authorizedWorkspaces(identity, "dashboard:create");
  const canCreate = editable.length > 0;

  // Filtering, ordering and paging all happen in SQL, per workspace. The page
  // is therefore taken from each workspace rather than from the union — in the
  // single-workspace install that is the same thing, and in a multi-workspace
  // one it is the honest version of "page 2" without a cross-workspace sort
  // the database cannot do in one statement.
  const pages = await Promise.all(
    workspaces.map((w) =>
      listDashboards(w, {
        search: query.search,
        tags: query.tags,
        sort: query.sort,
        limit: PAGE_SIZE,
        offset: pageOffset(query),
        userSub: identity.sub,
      }),
    ),
  );
  const dashboards = pages.flatMap((p) => p.dashboards);
  const total = pages.reduce((sum, p) => sum + p.total, 0);

  const tagLists = await Promise.all(workspaces.map((w) => listDashboardTags(w)));
  const tags = mergeTags(tagLists);

  // Favorites are their own section rather than a filter, so they are read
  // separately — and only on the unfiltered first page, where they are a
  // shortcut rather than a second copy of what is already on screen.
  const showSections = !isFiltered(query) && query.page === 1;
  const favorites = showSections
    ? (
        await Promise.all(
          workspaces.map((w) =>
            listDashboards(w, {
              sort: query.sort,
              limit: PAGE_SIZE,
              userSub: identity.sub,
              favoritesOnly: true,
            }),
          ),
        )
      ).flatMap((p) => p.dashboards)
    : [];

  const renderCard = (dashboard: DashboardSummary) => (
    <DashboardCard
      key={dashboard.id}
      dashboard={dashboard}
      canEdit={can(identity, "dashboard:update", {
        workspaceId: dashboard.workspaceId,
      })}
      canDelete={can(identity, "dashboard:delete", {
        workspaceId: dashboard.workspaceId,
        ownerSub: dashboard.createdBy,
      })}
      tagSuggestions={tags.map((t) => t.tag)}
    />
  );

  // The import dialog needs to know which sources each workspace offers, and
  // it needs it before the user picks a workspace. Projecting to an id and a
  // name here is what keeps `listSources` — which returns hosts, ports and the
  // whole catalog — from reaching the browser.
  const importTargets: ImportTarget[] = await Promise.all(
    editable.map(async (workspaceId) => ({
      workspaceId,
      sources: (await listSources(workspaceId)).map((s) => ({ id: s.id, name: s.name })),
    })),
  );

  // An empty *workspace* gets the guided first run; an empty *result* gets the
  // filter cleared. Telling them apart is the difference between "set Holotable
  // up" and "that search matched nothing".
  const emptyWorkspace = total === 0 && !isFiltered(query) && query.page === 1;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Dashboards</h1>
        {canCreate && (
          <div className="flex items-center gap-2">
            <ImportDashboard targets={importTargets} />
            <Link href="/dashboards/new">
              <Button collapse title="New dashboard" className="sm:w-44">
                <Plus className="h-4 w-4" /> <ButtonLabel>New dashboard</ButtonLabel>
              </Button>
            </Link>
          </div>
        )}
      </div>

      {emptyWorkspace ? (
        <FirstRunSection identity={identity} workspaces={workspaces} />
      ) : (
        <>
          <DashboardListControls query={query} tags={tags} />
          {showSections && <RecentDashboards />}

          {favorites.length > 0 && (
            <section className="mb-6">
              <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
                <Star className="h-3.5 w-3.5" aria-hidden /> Favorites
              </h2>
              <DashboardGridSection>{favorites.map(renderCard)}</DashboardGridSection>
            </section>
          )}

          <section>
            {showSections && favorites.length > 0 && (
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                All dashboards
              </h2>
            )}
            {dashboards.length === 0 ? (
              <EmptyState
                icon={<SearchX className="h-6 w-6" />}
                title="Nothing matches"
                description="No dashboard in your workspaces matches this search and these tags."
                action={
                  <Link
                    href={dashboardListHref({ ...query, search: "", tags: [], page: 1 })}
                  >
                    <Button variant="secondary">Clear filters</Button>
                  </Link>
                }
              />
            ) : (
              <DashboardGridSection>{dashboards.map(renderCard)}</DashboardGridSection>
            )}
          </section>

          <Pager page={query.page} pages={pageCount(total)} query={query} total={total} />
        </>
      )}
    </div>
  );
}

function DashboardGridSection({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {children}
    </div>
  );
}

/**
 * Previous/next as links, not buttons: a page of the list is a URL, so the
 * pager works without JavaScript and each page is somewhere the back button
 * can return to.
 */
function Pager({
  page,
  pages,
  query,
  total,
}: {
  page: number;
  pages: number;
  query: ReturnType<typeof parseDashboardQuery>;
  total: number;
}) {
  if (pages <= 1) return null;
  return (
    <nav
      aria-label="Dashboard pages"
      className="mt-6 flex items-center justify-between text-sm text-muted"
    >
      <span>
        Page {page} of {pages} · {total} dashboard{total === 1 ? "" : "s"}
      </span>
      <div className="flex gap-2">
        <PagerLink
          href={dashboardListHref({ ...query, page: page - 1 })}
          disabled={page <= 1}
        >
          Previous
        </PagerLink>
        <PagerLink
          href={dashboardListHref({ ...query, page: page + 1 })}
          disabled={page >= pages}
        >
          Next
        </PagerLink>
      </div>
    </nav>
  );
}

function PagerLink({
  href,
  disabled,
  children,
}: {
  href: string;
  disabled: boolean;
  children: ReactNode;
}) {
  if (disabled) {
    return (
      <span className="border border-border px-3 py-1.5 opacity-40">{children}</span>
    );
  }
  return (
    <Link
      href={href}
      className="border border-border px-3 py-1.5 text-foreground transition-colors hover:border-foreground/40 focus-visible:outline-2 focus-visible:outline-primary"
    >
      {children}
    </Link>
  );
}

/** One vocabulary out of several workspaces', counts added, commonest first. */
function mergeTags(lists: { tag: string; count: number }[][]) {
  const totals = new Map<string, number>();
  for (const list of lists) {
    for (const { tag, count } of list) {
      totals.set(tag, (totals.get(tag) ?? 0) + count);
    }
  }
  return [...totals]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * An empty dashboard list is the one place a new install is guaranteed to
 * land, so it is where the guided flow lives rather than on a route of its own
 * that nothing would send anyone to.
 *
 * The sources are read here only to decide two booleans. The catalog — table
 * and column names from a database the reader may not administer — is reduced
 * to a health verdict on the server and never reaches the browser.
 */
async function FirstRunSection({
  identity,
  workspaces,
}: {
  identity: Identity;
  workspaces: string[];
}) {
  const sourceLists = await Promise.all(workspaces.map((w) => listSources(w)));
  const jar = await cookies();

  const state = onboardingState({
    sources: sourceLists.flat().map((source) => ({ catalog: catalogHealth(source) })),
    // This branch is only rendered when the list is empty, but the state is
    // computed from the count rather than from that fact so the module stays
    // true away from this call site.
    dashboardCount: 0,
    canManageSources: authorizedWorkspaces(identity, "source:manage").length > 0,
    canCreateDashboards: authorizedWorkspaces(identity, "dashboard:create").length > 0,
  });

  return (
    <FirstRun
      state={state}
      dismissed={isDismissed(jar.get(SETUP_DISMISSED_COOKIE)?.value)}
    />
  );
}
