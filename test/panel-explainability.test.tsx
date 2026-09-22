import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Panel, TimeRange } from "@/lib/ir";
import { PanelView } from "@/components/dashboard/PanelView";
import { QueryPlanSection } from "@/components/sql/QueryPlanSection";
import { DESCRIPTION_RULE } from "@/lib/ai/generate";
import { mount } from "./support/dom";

/**
 * The two things a panel now says about itself: what it computes (#106) and
 * what the database is actually asked (#110).
 *
 * The shapes behind them are pinned as functions in `test/query-plan.test.ts`;
 * what is left needs a real mount. Note that the header's affordances are
 * asserted at the trigger: a Base UI popup renders through a portal that jsdom
 * does not mount, so what a test can state here is that the control exists,
 * carries a name, and is absent when there is nothing to show. The plan
 * section is mounted directly for the same reason, which is why it is its own
 * component rather than a private part of the dialog.
 */

const RANGE: TimeRange = { from: "now-15m", to: "now" };

function panel(overrides: Partial<Panel> = {}): Panel {
  return {
    id: "p1",
    title: "Requests",
    viz: "table",
    query: { sourceId: "src-1", sql: "SELECT ts, v FROM m", timeField: "ts" },
    layout: { x: 0, y: 0, w: 6, h: 4 },
    ...overrides,
  };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(body: unknown, init?: ResponseInit): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: string) => {
    urls.push(String(input));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
      ...init,
    });
  }) as typeof fetch;
  return urls;
}

async function settle(): Promise<void> {
  const { act } = await import("react");
  await act(async () => {});
}

function byLabel(root: ParentNode, label: RegExp): Element | null {
  return (
    [...root.querySelectorAll("[aria-label]")].find((el) =>
      label.test(el.getAttribute("aria-label") ?? ""),
    ) ?? null
  );
}

/* -------------------------------------------------------------------------- */
/* #106 — what this panel computes                                            */
/* -------------------------------------------------------------------------- */

test("a described panel offers it behind a named control, not in the header", async () => {
  const h = await mount();
  h.render(<PanelView panel={panel({ description: "Requests per minute by route" })} />);

  const trigger = byLabel(h.container, /What "Requests" computes/);
  assert.ok(trigger, "expected an info control");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  // On demand: a dense dashboard does not grow a paragraph per panel.
  assert.doesNotMatch(h.text(), /Requests per minute by route/);

  h.unmount();
});

test("a panel without a description renders exactly as before", async () => {
  const h = await mount();
  h.render(<PanelView panel={panel()} />);
  assert.equal(byLabel(h.container, /computes/), null);
  h.unmount();
});

test("the prompt requires a description and forbids inventing values", () => {
  assert.match(DESCRIPTION_RULE, /Every panel MUST carry a "description"/);
  assert.match(DESCRIPTION_RULE, /NEVER state, estimate or invent a result value/);
});

/* -------------------------------------------------------------------------- */
/* #110 — what actually runs                                                  */
/* -------------------------------------------------------------------------- */

const PLAN = {
  sql: "SELECT ts, v FROM m",
  executedSql:
    "SELECT * FROM (SELECT ts, v FROM m) AS _holo\nWHERE _holo.ts >= $1::timestamptz\n  AND _holo.ts < $2::timestamptz\nLIMIT 5000",
  params: [
    { placeholder: "$1", value: "2026-09-22T11:00:00.000Z", from: "now-15m" },
    { placeholder: "$2", value: "2026-09-22T12:00:00.000Z", from: "now" },
  ],
  timeField: "ts",
  maxRows: 5000,
  statementTimeoutMs: 30_000,
  maxResultBytes: 4_194_304,
  session: ["BEGIN TRANSACTION READ ONLY", 'SET LOCAL search_path TO "metrics", public'],
};

function button(root: ParentNode, label: string): Element {
  const found = [...root.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes(label),
  );
  assert.ok(found, `expected a ${label} button`);
  return found;
}

test("the plan is fetched only when asked for, and nothing is executed", async () => {
  const h = await mount();
  const urls = stubFetch(PLAN);
  h.render(<QueryPlanSection query={panel().query} timeRange={RANGE} />);
  assert.deepEqual(urls, [], "rendering the section fetches nothing");

  h.click(button(h.container, "Show"));
  await settle();

  assert.deepEqual(urls, ["/api/sql/plan"]);
  const text = h.text();
  assert.match(text, /_holo\.ts >= \$1/);
  assert.match(text, /resolved from now-15m/);
  assert.match(text, /5,000 rows · 30 s · 4\.0 MiB/);
  assert.match(text, /BEGIN TRANSACTION READ ONLY/);
  assert.match(text, /Nothing was executed to produce this/);

  h.unmount();
});

test("the server's own values are labelled as the server's", async () => {
  const h = await mount();
  stubFetch(PLAN);
  h.render(<QueryPlanSection query={panel().query} timeRange={RANGE} />);
  h.click(button(h.container, "Show"));
  await settle();

  assert.match(h.text(), /supplied by the server, not by the panel or the model/);
  assert.match(h.text(), /2026-09-22T11:00:00\.000Z/);

  h.unmount();
});

test("a panel with no time field says so instead of showing an empty list", async () => {
  const h = await mount();
  stubFetch({ ...PLAN, params: [], timeField: undefined });
  h.render(<QueryPlanSection query={panel().query} timeRange={RANGE} />);
  h.click(button(h.container, "Show"));
  await settle();

  assert.match(h.text(), /No time filter/);

  h.unmount();
});

test("a refusal is shown as the guard's own message, with a retry", async () => {
  const h = await mount();
  stubFetch(
    { error: 'table "secrets" is not allowlisted', kind: "statement" },
    { status: 400 },
  );
  h.render(<QueryPlanSection query={panel().query} timeRange={RANGE} />);
  h.click(button(h.container, "Show"));
  await settle();

  assert.match(h.text(), /is not allowlisted/);
  assert.ok(button(h.container, "Try again"));

  h.unmount();
});

test("a surface with no window does not offer a plan it cannot ask for", async () => {
  const h = await mount();
  h.render(<PanelView panel={panel()} />);
  // The dialog's own body is behind a portal; what this asserts is that
  // `PanelView` passes no window along, which is what gates the section.
  assert.doesNotMatch(h.text(), /What actually runs/);
  h.unmount();
});
