import { normalizeTag, normalizeTags } from "@/lib/dashboard-metadata";

/**
 * The dashboard list's own state: what is being searched for, which tags are
 * selected, how the results are ordered, and which page of them is showing.
 *
 * All of it lives in the URL. That is not decoration — a filtered list is the
 * thing people send each other ("the four prod dashboards, sorted by name"),
 * and it is what makes the list a server-rendered page rather than a client
 * that re-fetches: the server reads these params, asks the database for
 * exactly that page, and renders it. The client components here only rewrite
 * the URL.
 *
 * Every function below is pure so the parsing and the round trip can be tested
 * without a router, a database, or a browser.
 */

export const DASHBOARD_SORTS = ["updated", "title", "created"] as const;
export type DashboardSort = (typeof DASHBOARD_SORTS)[number];

export const DEFAULT_SORT: DashboardSort = "updated";

/** Four across on a wide screen, six rows. Also the API's default page size. */
export const PAGE_SIZE = 24;

/** The most pages a caller may ask the database to skip past. */
export const MAX_PAGE = 1000;

/** A search longer than this is a paste, not a search. */
export const SEARCH_MAX = 200;

export interface DashboardQuery {
  /** Free text, matched against the title and the description. */
  search: string;
  /** Selected tags, ANDed: a dashboard must carry all of them. */
  tags: string[];
  sort: DashboardSort;
  /** 1-based, so the URL reads the way the pager does. */
  page: number;
}

export const EMPTY_QUERY: DashboardQuery = {
  search: "",
  tags: [],
  sort: DEFAULT_SORT,
  page: 1,
};

/** Either shape a caller has on hand: Next's `searchParams`, or the real thing. */
export type QuerySource = URLSearchParams | Record<string, string | string[] | undefined>;

function read(source: QuerySource, key: string): string[] {
  if (source instanceof URLSearchParams) return source.getAll(key);
  const value = source[key];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Read a query out of a URL.
 *
 * Nothing here can fail: an unknown sort, a page of `-3`, a tag of pure
 * whitespace and a 10kB search string all fold back to something the list can
 * render, because a hand-edited URL should show a dashboard list rather than
 * an error page. The clamping is also what keeps a crafted `?page=` from
 * turning into an unbounded `OFFSET`.
 */
export function parseDashboardQuery(source: QuerySource): DashboardQuery {
  const sortParam = read(source, "sort")[0];
  const pageParam = Number(read(source, "page")[0]);

  return {
    search: (read(source, "q")[0] ?? "").trim().slice(0, SEARCH_MAX),
    // Tags arrive either repeated (`?tag=a&tag=b`) or comma-joined; both are
    // things people type, and both mean the same set.
    tags: normalizeTags(read(source, "tag").flatMap((t) => t.split(","))),
    sort: (DASHBOARD_SORTS as readonly string[]).includes(sortParam ?? "")
      ? (sortParam as DashboardSort)
      : DEFAULT_SORT,
    page: Number.isFinite(pageParam)
      ? Math.min(MAX_PAGE, Math.max(1, Math.trunc(pageParam)))
      : 1,
  };
}

/**
 * Write a query back into a URL query string, omitting everything that is at
 * its default.
 *
 * The omission matters more than it looks: `/dashboards` and
 * `/dashboards?q=&sort=updated&page=1` are the same list, and only one of them
 * should ever appear in someone's history.
 */
export function dashboardQueryString(query: DashboardQuery): string {
  const params = new URLSearchParams();
  if (query.search) params.set("q", query.search);
  for (const tag of query.tags) params.append("tag", tag);
  if (query.sort !== DEFAULT_SORT) params.set("sort", query.sort);
  if (query.page > 1) params.set("page", String(query.page));
  return params.toString();
}

/** `/dashboards`, or `/dashboards?…` when anything is set. */
export function dashboardListHref(query: DashboardQuery): string {
  const qs = dashboardQueryString(query);
  return qs ? `/dashboards?${qs}` : "/dashboards";
}

/**
 * Add or remove one tag, returning to page 1.
 *
 * Staying on page 4 while the result set changes underneath is the classic way
 * a filter appears to return nothing, so every narrowing resets the page.
 */
export function toggleTag(query: DashboardQuery, tag: string): DashboardQuery {
  const normalized = normalizeTag(tag);
  if (!normalized) return query;
  const tags = query.tags.includes(normalized)
    ? query.tags.filter((t) => t !== normalized)
    : normalizeTags([...query.tags, normalized]);
  return { ...query, tags, page: 1 };
}

/** Is the list showing a subset? What the "Clear" affordance keys off. */
export function isFiltered(query: DashboardQuery): boolean {
  return query.search !== "" || query.tags.length > 0;
}

/** Rows to skip for this page. */
export function pageOffset(query: DashboardQuery, size: number = PAGE_SIZE): number {
  return (query.page - 1) * size;
}

/** How many pages `total` rows make, at least one so the pager always renders. */
export function pageCount(total: number, size: number = PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / size));
}

/* -------------------------------------------------------------------------- */
/* Recently viewed                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Recently viewed is the one part of the list that is *not* in the URL and not
 * in the database.
 *
 * It is a per-browser convenience — which dashboards this person opened, in
 * what order — and storing it server-side would mean recording every view of
 * every dashboard by every user to answer a question nobody asks twice. So it
 * lives in `localStorage`, holds ids and nothing else, and the titles are
 * resolved by the ordinary authorized list endpoint: an id in storage grants
 * no access, and a dashboard that was deleted or that the reader can no longer
 * see simply does not come back.
 */
export const RECENT_KEY = "holotable.recent-dashboards";

/** Enough to be a shortcut, few enough to stay one row. */
export const RECENT_MAX = 6;

/** Put `id` at the front, keep the rest in order, and cap the list. */
export function recordVisit(
  ids: readonly string[],
  id: string,
  max: number = RECENT_MAX,
): string[] {
  if (!id) return [...ids].slice(0, max);
  return [id, ...ids.filter((existing) => existing !== id)].slice(0, max);
}

/**
 * Read the stored list, tolerating everything storage can do to it.
 *
 * `localStorage` throws in a private window, comes back empty when site data
 * is cleared, and holds whatever a previous version of this code wrote — so a
 * bad value yields an empty list rather than breaking the page that reads it.
 */
export function readRecent(storage: Pick<Storage, "getItem"> | undefined): string[] {
  try {
    const raw = storage?.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string").slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

/** Forget the recently viewed list (#216). */
export function clearRecent(
  storage: Pick<Storage, "removeItem"> | undefined | null,
): void {
  try {
    storage?.removeItem(RECENT_KEY);
  } catch {
    /* Already unreachable. */
  }
}

/** Write the list back, silently doing nothing when storage refuses. */
export function writeRecent(
  storage: Pick<Storage, "setItem"> | undefined,
  ids: readonly string[],
): void {
  try {
    storage?.setItem(RECENT_KEY, JSON.stringify(ids.slice(0, RECENT_MAX)));
  } catch {
    /* A reader with storage disabled just has no recent list. */
  }
}
