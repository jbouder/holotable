import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { SourceConfig } from "@/lib/registry";
import { SourceForm, type SourceFormValues } from "@/app/data-sources/source-form";
import { mount } from "./support/dom";

/**
 * The parts of the source form that only a mount can prove: that discovery
 * lists what the database has without allowlisting any of it, and that a
 * rejected field is called out where the user is looking rather than as a
 * message about a blob of JSON. Everything the form *computes* is tested as
 * functions in `source-form.test.ts`.
 */

const DISCOVERED = [
  {
    name: "http_requests",
    columns: [
      { name: "ts", type: "timestamp with time zone" },
      { name: "status", type: "smallint" },
    ],
  },
  {
    name: "cpu_usage",
    columns: [
      { name: "observed_at", type: "timestamp with time zone" },
      { name: "pct", type: "double precision" },
    ],
  },
];

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubDiscovery(body: unknown): { bodies: unknown[] } {
  const bodies: unknown[] = [];
  globalThis.fetch = (async (_input: string, init?: RequestInit) => {
    // Only a posted body is a discovery, and only those are what these tests
    // are counting.
    if (init?.body !== undefined) bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { bodies };
}

async function settle(): Promise<void> {
  const { act } = await import("react");
  await act(async () => {});
}

/** Set a controlled field's value the way a keystroke would. */
async function type(
  harness: Awaited<ReturnType<typeof mount>>,
  el: Element,
  value: string,
): Promise<void> {
  const view = harness.container.ownerDocument.defaultView;
  const prototype =
    el.tagName === "TEXTAREA"
      ? view?.HTMLTextAreaElement.prototype
      : view?.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype ?? {}, "value")?.set;
  const { act } = await import("react");
  await act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function connected(): SourceConfig {
  return {
    host: "timescaledb",
    port: 5432,
    database: "holotable",
    schema: "metrics",
    ssl: false,
    // A config needs a table; the tests that care remove it by ticking.
    tables: [DISCOVERED[0]],
  };
}

interface Rendered {
  harness: Awaited<ReturnType<typeof mount>>;
  submitted: SourceFormValues[];
}

async function renderForm(config: SourceConfig): Promise<Rendered> {
  const harness = await mount();
  const submitted: SourceFormValues[] = [];
  harness.render(
    <SourceForm
      mode="edit"
      workspaceId="ws-1"
      secretRefs={{ state: "ready", refs: [{ ref: "TS_METRICS", configured: true }] }}
      submitLabel="Save"
      initial={{ name: "Metrics", secretRef: "TS_METRICS", config }}
      onSubmit={async (values) => {
        submitted.push(values);
        return null;
      }}
    />,
  );
  return { harness, submitted };
}

/** The table picker's ticks, which excludes the SSL one above it. */
function checkboxes(container: HTMLElement): Element[] {
  return [...container.querySelectorAll('li [role="checkbox"]')];
}

function button(container: HTMLElement, label: string): Element {
  const found = [...container.querySelectorAll("button")].find((el) =>
    (el.textContent ?? "").includes(label),
  );
  assert.ok(found, `no button labelled ${label}`);
  return found;
}

test("discovery lists live tables, allowlists none of them, and unticks what it did not find", async () => {
  const { bodies } = stubDiscovery({ ok: true, tables: DISCOVERED });
  // Start from a config whose one table is not among the discovered ones, so
  // every discovered row starts unticked.
  const config = { ...connected(), tables: [{ ...DISCOVERED[0], name: "legacy" }] };
  const { harness, submitted } = await renderForm(config);

  harness.click(button(harness.container, "Discover tables"));
  await settle();

  assert.deepEqual(bodies, [
    {
      workspaceId: "ws-1",
      secretRef: "TS_METRICS",
      connection: {
        host: "timescaledb",
        port: 5432,
        database: "holotable",
        schema: "metrics",
        ssl: false,
      },
    },
  ]);
  assert.match(harness.text(), /http_requests/);
  assert.match(harness.text(), /cpu_usage/);

  // `legacy` is not in the schema, so discovery unticked it and said so; with
  // nothing ticked there is nothing to save.
  assert.match(harness.text(), /Unticked legacy: not found in schema metrics/);
  harness.click(button(harness.container, "Save"));
  await settle();
  assert.equal(submitted.length, 0);
  assert.match(harness.text(), /Select at least one table/);
  harness.unmount();
});

test("ticking a discovered table is what adds it, with its time column", async () => {
  stubDiscovery({ ok: true, tables: DISCOVERED });
  const config = { ...connected(), tables: [{ ...DISCOVERED[0], name: "legacy" }] };
  const { harness, submitted } = await renderForm(config);

  harness.click(button(harness.container, "Discover tables"));
  await settle();

  // `legacy` is not in the schema, so discovery unticked it; the rows are the
  // discovery, then what it did not find: http_requests, cpu_usage, legacy.
  const boxes = checkboxes(harness.container);
  assert.equal(boxes.length, 3);
  harness.click(boxes[1]);
  harness.click(button(harness.container, "Save"));
  await settle();

  const tables = submitted.at(0)?.config.tables ?? [];
  assert.deepEqual(
    tables.map((t) => t.name),
    ["cpu_usage"],
  );
  assert.equal(tables[0].timeField, "observed_at");
  harness.unmount();
});

test("an empty allowlist is refused, and says so under the table picker", async () => {
  const { harness, submitted } = await renderForm(connected());
  harness.click(checkboxes(harness.container)[0]);
  harness.click(button(harness.container, "Save"));
  await settle();

  assert.deepEqual(submitted, []);
  assert.match(harness.text(), /Select at least one table/);
  harness.unmount();
});

test("unticking a table leaves it on the picker, whole, to tick again", async () => {
  const { harness, submitted } = await renderForm({
    ...connected(),
    tables: [{ ...DISCOVERED[0], timeField: "ts", description: "per request" }],
  });

  harness.click(checkboxes(harness.container)[0]);
  assert.equal(checkboxes(harness.container).length, 1, "the row survived the untick");
  harness.click(checkboxes(harness.container)[0]);
  harness.click(button(harness.container, "Save"));
  await settle();

  assert.deepEqual(submitted.at(0)?.config.tables, [
    { ...DISCOVERED[0], timeField: "ts", description: "per request" },
  ]);
  harness.unmount();
});

test("a rejected field is reported on the field, not as a JSON error", async () => {
  const { harness, submitted } = await renderForm(connected());
  const host = harness.container.querySelector("#s-host");
  assert.ok(host);
  await type(harness, host, "");

  harness.click(button(harness.container, "Save"));
  await settle();

  assert.deepEqual(submitted, []);
  assert.match(harness.text(), /Host is required/);
  assert.equal(host.getAttribute("aria-invalid"), "true");
  harness.unmount();
});

test("the JSON view shows the form's config and edits flow back into it", async () => {
  const { harness, submitted } = await renderForm(connected());
  harness.click(button(harness.container, "Advanced (JSON)"));

  const textarea = harness.container.querySelector("#s-config") as HTMLTextAreaElement;
  assert.ok(textarea);
  assert.deepEqual(JSON.parse(textarea.value), connected());

  await type(harness, textarea, JSON.stringify({ ...connected(), schema: "public" }));
  harness.click(button(harness.container, "Back to the form"));
  harness.click(button(harness.container, "Save"));
  await settle();

  assert.equal(submitted.at(0)?.config.schema, "public");
  // The table the JSON carried is still allowlisted, and the form shows it.
  assert.deepEqual(
    submitted.at(0)?.config.tables.map((t) => t.name),
    ["http_requests"],
  );
  harness.unmount();
});

test("unparsed JSON is not applied, and is not silently dropped either", async () => {
  const { harness, submitted } = await renderForm(connected());
  harness.click(button(harness.container, "Advanced (JSON)"));
  const textarea = harness.container.querySelector("#s-config") as HTMLTextAreaElement;
  await type(harness, textarea, "{ not json");
  assert.match(harness.text(), /not valid JSON/);

  // Saving from inside the JSON view saves nothing rather than the version
  // before the unparsed edits.
  harness.click(button(harness.container, "Save"));
  await settle();
  assert.deepEqual(submitted, []);

  harness.click(button(harness.container, "Back to the form"));
  assert.match(harness.text(), /were not applied/);
  harness.click(button(harness.container, "Save"));
  await settle();
  assert.deepEqual(submitted.at(0)?.config, connected());
  harness.unmount();
});

test("a failed discovery surfaces the database's own message", async () => {
  stubDiscovery({ ok: false, error: 'password authentication failed for user "ro"' });
  const { harness } = await renderForm(connected());

  harness.click(button(harness.container, "Discover tables"));
  await settle();

  assert.match(harness.text(), /password authentication failed/);
  harness.unmount();
});
