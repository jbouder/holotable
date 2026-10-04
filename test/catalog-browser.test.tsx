import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { CatalogBrowser } from "@/components/sources/catalog-browser";
import type { CatalogView } from "@/lib/catalog/browse";
import type { CatalogHealth } from "@/lib/catalog/health";
import type { CatalogDiff } from "@/lib/catalog/refresh";
import { mount } from "./support/dom";

/**
 * What only a mount can prove about the catalog browser (#123): a viewer gets
 * no controls, a toggle sends exactly one column's change, and a refresh
 * writes only after Apply, re-reviewing when the database moved in between.
 * The view, search, diff and edit themselves are tested as functions in
 * `catalog-browse.test.ts` and `catalog-refresh.test.ts`.
 */

const HEALTH: CatalogHealth = {
  state: "ok",
  blocked: false,
  missingTables: [],
  liveTableCount: 2,
  refreshedAt: "2026-10-01T12:00:00.000Z",
  ageDays: 3,
};

function view(canManage: boolean, statusExposed = true): CatalogView {
  return {
    schema: "metrics",
    canManage,
    missingTables: [],
    catalogHealth: HEALTH,
    tables: [
      {
        name: "http_requests",
        timeField: "ts",
        columns: [
          { name: "ts", type: "timestamp with time zone" },
          {
            name: "status",
            type: "smallint",
            ...(statusExposed ? {} : { exposed: false }),
          },
        ],
      },
      { name: "cpu_usage", columns: [{ name: "pct", type: "double precision" }] },
    ],
  };
}

const DIFF: CatalogDiff = {
  missingTables: [],
  restoredTables: [],
  tables: [
    {
      table: "http_requests",
      added: [{ name: "region", type: "text" }],
      removed: [],
      retyped: [],
    },
  ],
};
const MOVED: CatalogDiff = {
  ...DIFF,
  tables: [{ ...DIFF.tables[0], added: [{ name: "zone", type: "text" }] }],
};
const D1 = "a".repeat(64);
const D2 = "b".repeat(64);

interface Call {
  method: string;
  url: string;
  body: unknown;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Route stubbed responses by method and path, and record every call. */
function stub(handler: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const call = {
      method: init?.method ?? "GET",
      url: String(input),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return calls;
}

async function settle(): Promise<void> {
  const { act } = await import("react");
  await act(async () => {});
}

function button(container: HTMLElement, label: string): Element {
  const found = [...container.querySelectorAll("button")].find((el) =>
    (el.textContent ?? "").includes(label),
  );
  assert.ok(found, `no button labelled ${label}`);
  return found;
}

/** Mount the browser; the role is whatever the stubbed view says. */
async function open(onChanged: (h: CatalogHealth) => void = () => {}) {
  const harness = await mount();
  harness.render(
    <CatalogBrowser source={{ id: "src-1", name: "Metrics" }} onChanged={onChanged} />,
  );
  await settle();
  return harness;
}

test("a viewer can browse but gets no toggle and no refresh", async () => {
  stub(() => respond(200, { view: view(false) }));
  const harness = await open();

  assert.match(harness.text(), /http_requests/);
  assert.match(harness.text(), /Read-only/);
  // Collapsed until opened.
  assert.doesNotMatch(harness.text(), /smallint/);
  harness.click(button(harness.container, "http_requests"));
  assert.match(harness.text(), /smallint/);
  assert.match(harness.text(), /time field/);

  assert.equal(harness.container.querySelectorAll('[role="checkbox"]').length, 0);
  assert.equal(
    [...harness.container.querySelectorAll("button")].some((b) =>
      (b.textContent ?? "").includes("Refresh"),
    ),
    false,
  );
  harness.unmount();
});

test("an admin's toggle sends exactly that column's change and shows the result", async () => {
  const calls = stub((call) =>
    call.method === "PATCH"
      ? respond(200, { view: view(true, false) })
      : call.url.includes("/catalog/impact")
        ? respond(200, {
            impact: { table: "http_requests", column: "status", dashboards: [] },
          })
        : respond(200, { view: view(true) }),
  );
  const changed: CatalogHealth[] = [];
  const harness = await open((h) => changed.push(h));

  harness.click(button(harness.container, "http_requests"));
  const boxes = [...harness.container.querySelectorAll('[role="checkbox"]')];
  assert.equal(boxes.length, 2);
  harness.click(boxes[1]);
  await settle();

  const patch = calls.find((c) => c.method === "PATCH");
  assert.ok(patch, "no PATCH was sent");
  assert.equal(patch.url, "/api/sources/src-1/catalog");
  assert.deepEqual(patch.body, {
    table: "http_requests",
    column: "status",
    exposed: false,
  });
  // Nothing reads it, so the hide went straight through after the check.
  assert.deepEqual(
    calls.map((c) => c.method),
    ["GET", "GET", "PATCH"],
  );
  assert.equal(
    calls[1].url,
    "/api/sources/src-1/catalog/impact?table=http_requests&column=status",
  );
  assert.match(harness.text(), /http_requests\.status is hidden/);
  assert.match(harness.text(), /1 hidden/);
  assert.equal(changed.length, 1);
  harness.unmount();
});

test("search opens the matching tables and narrows them to the matching columns", async () => {
  stub(() => respond(200, { view: view(false) }));
  const harness = await open();

  const input = harness.container.querySelector('input[type="search"]');
  assert.ok(input);
  const setter = Object.getOwnPropertyDescriptor(
    harness.container.ownerDocument.defaultView?.HTMLInputElement.prototype ?? {},
    "value",
  )?.set;
  const { act } = await import("react");
  await act(() => {
    setter?.call(input, "double");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  assert.match(harness.text(), /pct/);
  assert.doesNotMatch(harness.text(), /http_requests/);
  harness.unmount();
});

test("a refresh writes nothing until Apply, and re-reviews when the database moved", async () => {
  let applies = 0;
  const calls = stub((call) => {
    if (call.url.endsWith("/catalog")) return respond(200, { view: view(true) });
    const digest = (call.body as { digest?: string }).digest;
    if (digest === undefined) return respond(200, { diff: DIFF, digest: D1 });
    applies += 1;
    if (digest === D1) {
      return respond(409, {
        error: "The catalog changed since it was reviewed.",
        kind: "conflict",
        diff: MOVED,
        digest: D2,
      });
    }
    return respond(200, { diff: MOVED, catalogHealth: HEALTH });
  });
  const changed: CatalogHealth[] = [];
  const harness = await open((h) => changed.push(h));

  harness.click(button(harness.container, "Refresh"));
  await settle();
  // The preview, with nothing written.
  assert.deepEqual(
    calls.filter((c) => c.method === "POST").map((c) => c.body),
    [{}],
  );
  assert.match(harness.text(), /1 column added/);
  assert.match(harness.text(), /region/);
  assert.match(harness.text(), /New columns start exposed/);

  // Apply the reviewed digest; the database moved, so the new diff is shown.
  harness.click(button(harness.container, "Apply changes"));
  await settle();
  assert.equal(applies, 1);
  assert.match(harness.text(), /changed since it was reviewed/);
  assert.match(harness.text(), /zone/);
  assert.equal(changed.length, 0);

  // Applying again sends the new digest and lands.
  harness.click(button(harness.container, "Apply changes"));
  await settle();
  assert.deepEqual(
    calls.filter((c) => c.method === "POST").map((c) => c.body),
    [{}, { digest: D1 }, { digest: D2 }],
  );
  assert.equal(changed.length, 1);
  assert.match(harness.text(), /Catalog refreshed\. 1 column added/);
  harness.unmount();
});

const BROKEN = {
  table: "http_requests",
  column: "status",
  dashboards: [
    {
      id: "dash-1",
      title: "API health",
      panels: [
        { id: "p1", title: "Errors" },
        { id: "p2", title: "Status mix" },
      ],
    },
  ],
};

function stubWithImpact(): Call[] {
  return stub((call) =>
    call.method === "PATCH"
      ? respond(200, { view: view(true, false) })
      : call.url.includes("/catalog/impact")
        ? respond(200, { impact: BROKEN })
        : respond(200, { view: view(true) }),
  );
}

async function untickStatus() {
  const harness = await open();
  harness.click(button(harness.container, "http_requests"));
  harness.click(harness.container.querySelectorAll('[role="checkbox"]')[1]);
  await settle();
  return harness;
}

test("hiding a column that panels read lists them and waits for a confirmation", async () => {
  const calls = stubWithImpact();
  const harness = await untickStatus();

  assert.equal(calls.filter((c) => c.method === "PATCH").length, 0, "hid without asking");
  assert.match(harness.text(), /will break 2 panels across 1 dashboard/);
  assert.match(harness.text(), /API health/);
  assert.match(harness.text(), /Errors, Status mix/);
  const link = harness.container.querySelector('a[href="/dashboards/dash-1"]');
  assert.ok(link, "the affected dashboard is linked");
  // Nothing else can be toggled while the question is open.
  for (const box of harness.container.querySelectorAll('[role="checkbox"]')) {
    assert.notEqual(box.getAttribute("data-disabled"), null, "a checkbox stayed enabled");
  }

  harness.click(button(harness.container, "Hide anyway"));
  await settle();
  const patch = calls.find((c) => c.method === "PATCH");
  assert.deepEqual(patch?.body, {
    table: "http_requests",
    column: "status",
    exposed: false,
  });
  assert.doesNotMatch(harness.text(), /will break/);
  assert.match(harness.text(), /http_requests\.status is hidden/);
  harness.unmount();
});

test("keeping the column exposed sends nothing", async () => {
  const calls = stubWithImpact();
  const harness = await untickStatus();

  harness.click(button(harness.container, "Keep exposed"));
  await settle();
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 0);
  assert.doesNotMatch(harness.text(), /will break/);
  harness.unmount();
});

test("exposing a column never asks", async () => {
  const calls = stub((call) =>
    call.method === "PATCH"
      ? respond(200, { view: view(true) })
      : respond(200, { view: view(true, false) }),
  );
  const harness = await open();
  harness.click(button(harness.container, "http_requests"));
  harness.click(harness.container.querySelectorAll('[role="checkbox"]')[1]);
  await settle();
  assert.deepEqual(
    calls.map((c) => c.method),
    ["GET", "PATCH"],
  );
  assert.deepEqual(calls[1].body, {
    table: "http_requests",
    column: "status",
    exposed: true,
  });
  harness.unmount();
});
