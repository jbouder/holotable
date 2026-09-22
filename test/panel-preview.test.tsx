import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Panel, TimeRange } from "@/lib/ir";
import { PanelPreview, usePanelPreview } from "@/components/dashboard/PanelPreview";
import { mount } from "./support/dom";

/**
 * The editor's Validate and Run preview.
 *
 * `src/lib/panel-query.ts` is where the request shape and the error mapping are
 * pinned as functions; what is left to prove here needs a real mount — that the
 * result renders through `PanelView` with the panel's own viz, that the two
 * actions send nothing but their own request, and that a verdict stops being
 * presented as current once the query it answered has been edited.
 */

const RANGE: TimeRange = { from: "now-15m", to: "now" };

function panel(overrides: Partial<Panel["query"]> = {}): Panel {
  return {
    id: "p1",
    title: "Requests",
    viz: "table",
    query: {
      sourceId: "src-1",
      sql: "SELECT ts, v FROM m",
      timeField: "ts",
      ...overrides,
    },
    layout: { x: 0, y: 0, w: 6, h: 4 },
  };
}

function Host({ p }: { p: Panel }) {
  const preview = usePanelPreview(p, RANGE);
  return <PanelPreview panel={p} preview={preview} />;
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

/** Let the in-flight request settle and React re-render. */
async function settle(): Promise<void> {
  const { act } = await import("react");
  await act(async () => {});
}

function button(h: Awaited<ReturnType<typeof mount>>, label: string): Element {
  const found = [...h.container.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes(label),
  );
  assert.ok(found, `expected a ${label} button`);
  return found;
}

test("Run preview renders the rows inline with the panel's own viz", async () => {
  const h = await mount();
  const urls = stubFetch({ columns: ["ts", "v"], rows: [{ ts: "t0", v: 41 }] });

  h.render(<Host p={panel()} />);
  h.click(button(h, "Run preview"));
  await settle();

  // The table viz rendered, so the preview went through PanelView.
  assert.match(h.text(), /41/);
  assert.equal(h.container.querySelectorAll("table").length, 1);
  assert.match(h.text(), /1 row in/);
  // One request, to the guarded query route — nothing was saved.
  assert.deepEqual(urls, ["/api/query"]);

  h.unmount();
});

test("a failed run shows the message and offers a retry, not rows", async () => {
  const h = await mount();
  stubFetch(
    { error: 'column "nope" does not exist', kind: "statement" },
    { status: 400 },
  );

  h.render(<Host p={panel()} />);
  h.click(button(h, "Run preview"));
  await settle();

  assert.match(h.text(), /does not exist/);
  // The statement hint, not a generic one — this is invariant 16's actionable half.
  assert.match(h.text(), /Check the name against the source's catalog/);
  assert.ok(button(h, "Retry"));
  assert.equal(h.container.querySelectorAll("table").length, 0);

  h.unmount();
});

test("Validate reports a rejection without running anything", async () => {
  const h = await mount();
  const urls = stubFetch({ ok: false, error: 'table "secrets" is not allowlisted' });

  h.render(<Host p={panel()} />);
  h.click(button(h, "Validate"));
  await settle();

  assert.match(h.text(), /is not allowlisted/);
  assert.deepEqual(urls, ["/api/sql/validate"]);

  h.unmount();
});

test("editing the query retracts a passing verdict and marks the result stale", async () => {
  const h = await mount();
  stubFetch({ ok: true });

  h.render(<Host p={panel()} />);
  h.click(button(h, "Validate"));
  await settle();
  assert.match(h.text(), /passes the guard/);

  stubFetch({ columns: ["v"], rows: [{ v: 1 }] });
  h.click(button(h, "Run preview"));
  await settle();
  assert.doesNotMatch(h.text(), /has been edited/);

  // Same panel, edited SQL: the verdict answered a question that no longer
  // exists, so it goes, and the result is labelled for what it is.
  h.render(<Host p={panel({ sql: "SELECT v FROM m" })} />);
  assert.doesNotMatch(h.text(), /passes the guard/);
  assert.match(h.text(), /has been edited since this ran/);

  h.unmount();
});
