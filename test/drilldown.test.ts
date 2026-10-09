import { test } from "node:test";
import assert from "node:assert/strict";
import type { Identity } from "@/lib/auth/claims";
import {
  applySelfLink,
  hasUsableLinks,
  type LinkContext,
  linkHref,
  linkTargetIds,
  menuLinks,
  withoutDashboardLinks,
} from "@/lib/drilldown";
import { resolveLinkTargets } from "@/lib/drilldown-targets";
import {
  Dashboard,
  type Panel,
  type PanelLink,
  SPEC_VERSION,
  TimeExpr,
  VariableName,
} from "@/lib/ir";
import { dashboardTemplateBody, panelTemplateBody } from "@/lib/templates";
import { rangeFromParams } from "@/lib/time-range";
import { selectionFromParams } from "@/lib/variable-selection";

/** Drilldown, Phase 2 (#372): which links a viewer sees, and where they lead. */

const HOST = "11111111-1111-4111-8111-111111111111";
const GONE = "22222222-2222-4222-8222-222222222222";

const CONTEXT: LinkContext = {
  timeRange: { from: "now-6h", to: "now" },
  selection: { service: ["api"], routes: ["/a", "/b"] },
};

function link(l: Partial<PanelLink> = {}): PanelLink {
  return { title: "Host detail", dashboard: HOST, ...l };
}

function panel(links: PanelLink[]): Panel {
  return {
    id: "p",
    title: "Hosts",
    viz: "table",
    query: { sourceId: "s", sql: "SELECT host FROM m" },
    layout: { x: 0, y: 0, w: 6, h: 4 },
    links,
  };
}

/** What a target page reads back out of an href, as it would from a typed URL. */
function arrive(href: string) {
  const url = new URL(href, "http://holotable.test");
  const fallback = { from: "now-1h", to: "now" };
  return {
    path: url.pathname,
    range: rangeFromParams(Object.fromEntries(url.searchParams), fallback),
    hasRange: url.searchParams.has("from"),
    selection: selectionFromParams(url.searchParams),
  };
}

test("a link carries the viewer's window and picks by default", () => {
  const at = arrive(linkHref(link(), HOST, CONTEXT));
  assert.equal(at.path, `/dashboards/${HOST}`);
  assert.deepEqual(at.range, CONTEXT.timeRange);
  assert.deepEqual(at.selection, CONTEXT.selection);
});

test("carry false drops the window or the picks; literal picks win over carried ones", () => {
  const noRange = arrive(linkHref(link({ carry: { timeRange: false } }), HOST, CONTEXT));
  assert.equal(noRange.hasRange, false);
  assert.deepEqual(noRange.selection, CONTEXT.selection);

  const noPicks = arrive(linkHref(link({ carry: { variables: false } }), HOST, CONTEXT));
  assert.deepEqual(noPicks.selection, {});
  assert.deepEqual(noPicks.range, CONTEXT.timeRange);

  const literal = arrive(
    linkHref(
      link({ carry: { variables: false }, set: { env: { value: "prod & co" } } }),
      HOST,
      CONTEXT,
    ),
  );
  assert.deepEqual(literal.selection, { env: ["prod & co"] });

  const over = arrive(
    linkHref(link({ set: { service: { value: "web" } } }), HOST, CONTEXT),
  );
  assert.deepEqual(over.selection, { ...CONTEXT.selection, service: ["web"] });
});

test("an href holds only IR time expressions and variable names", () => {
  const href = linkHref(link({ set: { env: { value: "x" } } }), HOST, {
    timeRange: { from: "2026-10-01T00:00:00Z", to: "now" },
    selection: { a_b: ["1"] },
  });
  const params = new URL(href, "http://holotable.test").searchParams;
  for (const [key, value] of params) {
    if (key === "from" || key === "to") {
      assert.ok(TimeExpr.safeParse(value).success, `${key}=${value}`);
    } else {
      assert.match(key, /^var-/);
      assert.ok(VariableName.safeParse(key.slice(4)).success, key);
    }
  }
});

test("a datum pick is never written by linkHref: it needs a click (#373)", () => {
  const at = arrive(
    linkHref(link({ set: { host: { column: "host" } } }), HOST, {
      ...CONTEXT,
      selection: {},
    }),
  );
  assert.deepEqual(at.selection, {});
});

test("the target id is encoded, so it cannot escape the dashboard path", () => {
  const href = linkHref(link(), "../../api/x?y", { ...CONTEXT, selection: {} });
  assert.ok(href.startsWith("/dashboards/..%2F..%2Fapi%2Fx%3Fy?"), href);
});

test("a self link sets its literal picks over the current selection", () => {
  const self = link({ dashboard: undefined, set: { service: { value: "web" } } });
  assert.deepEqual(applySelfLink(self, CONTEXT.selection), {
    service: ["web"],
    routes: ["/a", "/b"],
  });
});

test("the menu offers a working href only for a target the server named", () => {
  const items = menuLinks(
    panel([
      link(),
      link({ title: "Gone", dashboard: GONE }),
      link({ title: "Filter", dashboard: undefined, set: { service: { value: "web" } } }),
      link({ title: "Datum", set: { host: { column: "host" } } }),
      link({ title: "Tab", newTab: true }),
    ]),
    { [HOST]: { title: "Host" } },
    CONTEXT,
  );
  assert.deepEqual(
    items.map((i) => [i.kind, i.title]),
    [
      ["navigate", "Host detail"],
      ["unavailable", "Gone"],
      ["self", "Filter"],
      ["navigate", "Tab"],
    ],
  );
  // Nothing about an unavailable target reaches the browser but its title.
  assert.deepEqual(items[1], { kind: "unavailable", title: "Gone" });
  assert.equal(items[3]?.kind === "navigate" && items[3].newTab, true);
  assert.equal(hasUsableLinks(items), true);
  assert.equal(hasUsableLinks([items[1] as (typeof items)[number]]), false);
});

test("an inherited object key is not a target", () => {
  const items = menuLinks(panel([link({ dashboard: "constructor" })]), {}, CONTEXT);
  assert.deepEqual(items, [{ kind: "unavailable", title: "Host detail" }]);
});

test("linkTargetIds lists each target once and skips self links", () => {
  assert.deepEqual(
    linkTargetIds({
      panels: [
        panel([link(), link({ title: "b", dashboard: undefined, set: {} })]),
        panel([link({ title: "c" }), link({ title: "d", dashboard: GONE })]),
      ],
    }),
    [HOST, GONE],
  );
});

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

function viewer(workspaceId: string): Identity {
  return { sub: "u", platformAdmin: false, workspaces: { [workspaceId]: "viewer" } };
}

test("targets are only those found in the dashboard's own workspace, for a viewer of it", async () => {
  const asked: [string, string[]][] = [];
  const load = async (workspaceId: string, ids: string[]) => {
    asked.push([workspaceId, ids]);
    return new Map([[HOST, "Host detail"]]);
  };
  const spec = { panels: [panel([link(), link({ title: "g", dashboard: GONE })])] };

  assert.deepEqual(
    await resolveLinkTargets({ identity: viewer("ws"), workspaceId: "ws", spec, load }),
    { [HOST]: { title: "Host detail" } },
  );
  assert.deepEqual(asked, [["ws", [HOST, GONE]]]);

  // A viewer of another workspace gets nothing, and nothing is looked up.
  asked.length = 0;
  assert.deepEqual(
    await resolveLinkTargets({
      identity: viewer("other"),
      workspaceId: "ws",
      spec,
      load,
    }),
    {},
  );
  assert.deepEqual(asked, []);

  // A spec without links costs no query.
  assert.deepEqual(
    await resolveLinkTargets({
      identity: viewer("ws"),
      workspaceId: "ws",
      spec: { panels: [panel([])] },
      load,
    }),
    {},
  );
  assert.deepEqual(asked, []);
});

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

test("a dashboard template keeps self links only; a panel template keeps none", () => {
  const self = link({
    title: "Filter",
    dashboard: undefined,
    set: { service: { value: "web" } },
  });
  const spec = Dashboard.parse({
    specVersion: SPEC_VERSION,
    title: "D",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 15_000,
    variables: [{ name: "service", type: "enum", values: ["api", "web"] }],
    panels: [panel([link(), self]), { ...panel([link()]), id: "q" }],
  });

  const body = dashboardTemplateBody(spec);
  assert.equal(body.kind, "dashboard");
  if (body.kind !== "dashboard") return;
  assert.deepEqual(body.dashboard.panels[0]?.links, [self]);
  assert.equal("links" in (body.dashboard.panels[1] ?? {}), false);

  const lone = panelTemplateBody(spec.panels[0] as Panel);
  assert.equal(lone.kind === "panel" && "links" in lone.panel, false);
  assert.deepEqual(withoutDashboardLinks({ links: undefined }), { links: undefined });
});
