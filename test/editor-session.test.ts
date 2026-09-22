import { test } from "node:test";
import assert from "node:assert/strict";
import type { Dashboard } from "../src/lib/ir";
import {
  interceptedHref,
  isDirty,
  relativeTime,
  specFingerprint,
} from "../src/lib/editor/session";

/**
 * The editor session: dirtiness and the unsaved-changes guard (#117).
 */

function spec(patch: Partial<Dashboard> = {}): Dashboard {
  return {
    title: "Ops",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 30_000,
    panels: [
      {
        id: "p1",
        title: "Requests",
        viz: "line",
        query: { sourceId: "src", sql: "SELECT 1 AS value" },
        layout: { x: 0, y: 0, w: 6, h: 4 },
      },
    ],
    ...patch,
  };
}

test("an unchanged spec is not dirty, whatever order its keys were built in", () => {
  const a = spec();
  const b: Dashboard = {
    panels: a.panels.map((p) => ({
      layout: p.layout,
      query: { sql: p.query.sql, sourceId: p.query.sourceId },
      viz: p.viz,
      title: p.title,
      id: p.id,
    })),
    refreshIntervalMs: a.refreshIntervalMs,
    timeRange: { to: a.timeRange.to, from: a.timeRange.from },
    title: a.title,
  };
  assert.equal(specFingerprint(a), specFingerprint(b));
  assert.equal(isDirty(a, b), false);
});

test("an edit and an edit undone are reported honestly", () => {
  const saved = spec();
  assert.equal(isDirty(spec({ title: "Ops v2" }), saved), true);
  // Typing a character and deleting it again is not a change.
  assert.equal(isDirty(spec({ title: "Ops" }), saved), false);
});

test("panel order is a change, because panel order is meaningful", () => {
  const second = {
    ...spec().panels[0],
    id: "p2",
    layout: { x: 6, y: 0, w: 6, h: 4 },
  };
  const a = spec({ panels: [spec().panels[0], second] });
  const b = spec({ panels: [second, spec().panels[0]] });
  assert.equal(isDirty(a, b), true);
});

const base = {
  target: null,
  download: false,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  button: 0,
  origin: "https://holotable.example",
  currentPath: "/dashboards/abc/edit",
};

test("an ordinary in-app link is intercepted, with its query string", () => {
  assert.equal(interceptedHref({ ...base, href: "/dashboards" }), "/dashboards");
  assert.equal(
    interceptedHref({ ...base, href: "/explore?source=src#top" }),
    "/explore?source=src#top",
  );
  assert.equal(
    interceptedHref({
      ...base,
      href: "https://holotable.example/data-sources",
    }),
    "/data-sources",
  );
});

test("clicks that do not replace this document are left alone", () => {
  assert.equal(interceptedHref({ ...base, href: "https://example.com/x" }), null);
  assert.equal(interceptedHref({ ...base, href: "/dashboards", target: "_blank" }), null);
  assert.equal(interceptedHref({ ...base, href: "/export.json", download: true }), null);
  assert.equal(interceptedHref({ ...base, href: "/dashboards", metaKey: true }), null);
  assert.equal(interceptedHref({ ...base, href: "/dashboards", ctrlKey: true }), null);
  assert.equal(interceptedHref({ ...base, href: "/dashboards", shiftKey: true }), null);
  assert.equal(interceptedHref({ ...base, href: "/dashboards", button: 1 }), null);
  assert.equal(interceptedHref({ ...base, href: null }), null);
  assert.equal(interceptedHref({ ...base, href: "not a url", origin: "" }), null);
});

test("a fragment on the page we are already on is not a departure", () => {
  assert.equal(interceptedHref({ ...base, href: "#panels" }), null);
  assert.equal(interceptedHref({ ...base, href: "/dashboards/abc/edit" }), null);
  // The same path with a different query IS a navigation the guard should catch.
  assert.equal(
    interceptedHref({ ...base, href: "/dashboards/abc/edit?panel=p2" }),
    "/dashboards/abc/edit?panel=p2",
  );
});

test("the last-saved line reads as a person would say it", () => {
  const now = 1_700_000_000_000;
  assert.equal(relativeTime(now, now), "just now");
  assert.equal(relativeTime(now - 30_000, now), "just now");
  assert.equal(relativeTime(now - 60_000, now), "1 minute ago");
  assert.equal(relativeTime(now - 180_000, now), "3 minutes ago");
  assert.equal(relativeTime(now - 3_600_000, now), "1 hour ago");
  assert.equal(relativeTime(now - 2 * 86_400_000, now), "2 days ago");
  // A clock that ran backwards must not produce a negative age.
  assert.equal(relativeTime(now + 10_000, now), "just now");
});
