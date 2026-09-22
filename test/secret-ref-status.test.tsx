import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { SourceConfig } from "@/lib/registry";
import { SourceForm, type SourceFormValues } from "@/app/data-sources/source-form";
import { READINESS_DEBOUNCE_MS } from "@/app/data-sources/secret-ref-status";
import { mount } from "./support/dom";

/**
 * What the source form says about a `secret_ref` before anyone presses Test.
 *
 * The verdict itself is tested as a function in `secret-refs.test.ts`; what a
 * mount proves is that the user is told before the fact, that the message
 * names the variables an operator has to set, and — the point of the whole
 * feature being a warning rather than a gate — that an unconfigured ref still
 * saves.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answer readiness checks; record the refs asked about. */
function stubReadiness(configured: boolean): { asked: string[] } {
  const asked: string[] = [];
  globalThis.fetch = (async (input: string) => {
    const url = new URL(String(input), "http://localhost");
    const ref = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    asked.push(ref);
    return new Response(JSON.stringify({ ref, configured }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { asked };
}

/** Let the debounce elapse and the resulting render flush. */
async function settleReadiness(): Promise<void> {
  const { act } = await import("react");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, READINESS_DEBOUNCE_MS + 40));
  });
}

function config(): SourceConfig {
  return {
    host: "timescaledb",
    port: 5432,
    database: "holotable",
    schema: "metrics",
    ssl: false,
    tables: [
      {
        name: "http_requests",
        timeField: "ts",
        columns: [{ name: "ts", type: "timestamp with time zone" }],
      },
    ],
  };
}

async function renderForm(secretRef: string) {
  const harness = await mount();
  const submitted: SourceFormValues[] = [];
  harness.render(
    <SourceForm
      mode="edit"
      workspaceId="ws-1"
      submitLabel="Save"
      initial={{ name: "Metrics", secretRef, config: config() }}
      onSubmit={async (values) => {
        submitted.push(values);
        return null;
      }}
    />,
  );
  return { harness, submitted };
}

function button(container: HTMLElement, label: string): Element {
  const found = [...container.querySelectorAll("button")].find((el) =>
    (el.textContent ?? "").includes(label),
  );
  assert.ok(found, `no button labelled ${label}`);
  return found;
}

test("a configured ref is confirmed before Test is ever pressed", async () => {
  const { asked } = stubReadiness(true);
  const { harness } = await renderForm("TS_METRICS");

  await settleReadiness();

  assert.deepEqual(asked, ["TS_METRICS"]);
  assert.match(harness.text(), /Credentials for TS_METRICS are configured/);
  harness.unmount();
});

test("an unconfigured ref warns with the variables to set, and still saves", async () => {
  stubReadiness(false);
  const { harness, submitted } = await renderForm("TS_METRICS");

  await settleReadiness();
  assert.match(harness.text(), /No credentials on the server for TS_METRICS/);
  assert.match(harness.text(), /TS_METRICS_USERNAME[\s\S]*TS_METRICS_PASSWORD/);

  harness.click(button(harness.container, "Save"));
  await settleReadiness();
  assert.equal(submitted.length, 1, "the warning did not block the save");
  assert.equal(submitted[0].secretRef, "TS_METRICS");
  harness.unmount();
});

test("a ref that cannot be valid is never asked about", async () => {
  const { asked } = stubReadiness(true);
  const { harness } = await renderForm("ts-metrics");

  await settleReadiness();

  assert.deepEqual(asked, []);
  assert.doesNotMatch(harness.text(), /configured on the server/);
  harness.unmount();
});
