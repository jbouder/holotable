import { test } from "node:test";
import assert from "node:assert/strict";
import type { DashboardQuery } from "@/lib/dashboard-list";
import {
  dashboardListHref,
  dashboardQueryString,
  DEFAULT_SORT,
  EMPTY_QUERY,
  isFiltered,
  MAX_PAGE,
  PAGE_SIZE,
  pageCount,
  pageOffset,
  parseDashboardQuery,
  RECENT_MAX,
  readRecent,
  recordVisit,
  SEARCH_MAX,
  toggleTag,
  writeRecent,
} from "@/lib/dashboard-list";

/* -------------------------------------------------------------------------- */
/* Reading a query out of a URL                                               */
/* -------------------------------------------------------------------------- */

const parse = (qs: string) => parseDashboardQuery(new URLSearchParams(qs));

test("an empty URL is the default list", () => {
  assert.deepEqual(parse(""), EMPTY_QUERY);
  assert.equal(EMPTY_QUERY.sort, DEFAULT_SORT);
});

test("search, tags, sort and page are read back", () => {
  assert.deepEqual(parse("q=errors&tag=prod&tag=api&sort=title&page=3"), {
    search: "errors",
    tags: ["api", "prod"],
    sort: "title",
    page: 3,
  });
});

test("tags arrive repeated or comma-joined and mean the same set", () => {
  assert.deepEqual(parse("tag=prod,api").tags, parse("tag=prod&tag=api").tags);
});

test("tags from the URL are normalized like any other tag", () => {
  assert.deepEqual(parse("tag=%20PROD%20&tag=prod").tags, ["prod"]);
});

test("a hand-edited URL never fails, it folds back to something renderable", () => {
  assert.equal(parse("sort=DROP+TABLE").sort, DEFAULT_SORT);
  assert.equal(parse("page=-3").page, 1);
  assert.equal(parse("page=nonsense").page, 1);
  assert.equal(parse("page=0").page, 1);
  assert.equal(parse("page=2.9").page, 2);
});

test("the page is clamped, so a crafted URL cannot become an unbounded OFFSET", () => {
  assert.equal(parse(`page=${MAX_PAGE * 1000}`).page, MAX_PAGE);
  assert.ok(pageOffset(parse(`page=${MAX_PAGE * 1000}`)) <= MAX_PAGE * PAGE_SIZE);
});

test("an enormous search string is truncated rather than passed on", () => {
  assert.equal(parse(`q=${"x".repeat(SEARCH_MAX * 10)}`).search.length, SEARCH_MAX);
});

test("Next's searchParams object reads the same as URLSearchParams", () => {
  assert.deepEqual(
    parseDashboardQuery({ q: "errors", tag: ["prod", "api"], page: "2" }),
    { search: "errors", tags: ["api", "prod"], sort: DEFAULT_SORT, page: 2 },
  );
});

/* -------------------------------------------------------------------------- */
/* Writing one back                                                           */
/* -------------------------------------------------------------------------- */

test("defaults are omitted, so the plain list has one URL", () => {
  assert.equal(dashboardQueryString(EMPTY_QUERY), "");
  assert.equal(dashboardListHref(EMPTY_QUERY), "/dashboards");
});

test("a query survives the round trip through a URL", () => {
  const query: DashboardQuery = {
    search: "p95 latency",
    tags: ["api", "prod"],
    sort: "title",
    page: 4,
  };
  assert.deepEqual(parse(dashboardQueryString(query)), query);
});

test("a search containing a wildcard or an ampersand round-trips intact", () => {
  const query = { ...EMPTY_QUERY, search: "100% & _rate" };
  assert.deepEqual(parse(dashboardQueryString(query)), query);
});

/* -------------------------------------------------------------------------- */
/* Narrowing                                                                  */
/* -------------------------------------------------------------------------- */

test("toggling a tag adds it, then removes it", () => {
  const one = toggleTag(EMPTY_QUERY, "prod");
  assert.deepEqual(one.tags, ["prod"]);
  assert.deepEqual(toggleTag(one, "prod").tags, []);
});

test("toggling normalizes, so a chip and a typed tag are the same tag", () => {
  assert.deepEqual(toggleTag({ ...EMPTY_QUERY, tags: ["prod"] }, " PROD ").tags, []);
  assert.deepEqual(toggleTag(EMPTY_QUERY, "   ").tags, []);
});

test("narrowing returns to page 1, so a filter never lands past the results", () => {
  assert.equal(toggleTag({ ...EMPTY_QUERY, page: 5 }, "prod").page, 1);
});

test("only a search or a tag counts as filtered — sorting and paging do not", () => {
  assert.equal(isFiltered(EMPTY_QUERY), false);
  assert.equal(isFiltered({ ...EMPTY_QUERY, sort: "title", page: 3 }), false);
  assert.equal(isFiltered({ ...EMPTY_QUERY, search: "x" }), true);
  assert.equal(isFiltered({ ...EMPTY_QUERY, tags: ["prod"] }), true);
});

test("paging maths", () => {
  assert.equal(pageOffset(EMPTY_QUERY), 0);
  assert.equal(pageOffset({ ...EMPTY_QUERY, page: 3 }), PAGE_SIZE * 2);
  // Always at least one page, so the pager has something true to say about an
  // empty list.
  assert.equal(pageCount(0), 1);
  assert.equal(pageCount(PAGE_SIZE), 1);
  assert.equal(pageCount(PAGE_SIZE + 1), 2);
});

/* -------------------------------------------------------------------------- */
/* Recently viewed                                                            */
/* -------------------------------------------------------------------------- */

test("a visit goes to the front and is not duplicated", () => {
  assert.deepEqual(recordVisit(["a", "b"], "c"), ["c", "a", "b"]);
  assert.deepEqual(recordVisit(["a", "b", "c"], "c"), ["c", "a", "b"]);
});

test("the recent list is capped at the oldest end", () => {
  const ids = Array.from({ length: RECENT_MAX + 3 }, (_, i) => `id-${i}`);
  const next = recordVisit(ids, "new");
  assert.equal(next.length, RECENT_MAX);
  assert.equal(next[0], "new");
});

test("storage that throws, or holds junk, reads as no recent dashboards", () => {
  assert.deepEqual(readRecent(undefined), []);
  assert.deepEqual(
    readRecent({
      getItem() {
        throw new Error("SecurityError: storage is blocked");
      },
    }),
    [],
  );
  assert.deepEqual(readRecent({ getItem: () => "not json" }), []);
  assert.deepEqual(readRecent({ getItem: () => '{"a":1}' }), []);
  assert.deepEqual(readRecent({ getItem: () => "[1,2,3]" }), []);
  assert.deepEqual(readRecent({ getItem: () => '["a",2,"b"]' }), ["a", "b"]);
});

test("writing to storage that refuses is not an error the page has to handle", () => {
  assert.doesNotThrow(() =>
    writeRecent(
      {
        setItem() {
          throw new Error("QuotaExceededError");
        },
      },
      ["a"],
    ),
  );
});

test("a stored list longer than the cap is trimmed on the way in and out", () => {
  const ids = Array.from({ length: RECENT_MAX + 5 }, (_, i) => `id-${i}`);
  let written = "";
  writeRecent(
    {
      setItem: (_k, v) => {
        written = v;
      },
    },
    ids,
  );
  assert.equal(JSON.parse(written).length, RECENT_MAX);
  assert.equal(readRecent({ getItem: () => JSON.stringify(ids) }).length, RECENT_MAX);
});
