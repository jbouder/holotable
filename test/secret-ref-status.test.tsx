import { test } from "node:test";
import assert from "node:assert/strict";
import type { SourceConfig } from "@/lib/registry";
import type { GrantedSecretRefsState } from "@/lib/secret-refs";
import { SourceForm, type SourceFormValues } from "@/app/data-sources/source-form";
import { mount } from "./support/dom";

/**
 * What the source form says about a `secret_ref` before anyone presses Test.
 *
 * The verdicts are tested as functions in `secret-refs.test.ts`; what a mount
 * proves is that the picker offers only what the workspace is granted, that
 * the user is told before the fact, that a missing credential names the
 * variables an operator has to set and still saves, and that an install that
 * grants nothing says so instead of offering a ref that cannot resolve.
 */

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

async function renderForm(
  secretRefs: GrantedSecretRefsState,
  initial: { secretRef?: string } = {},
) {
  const harness = await mount();
  const submitted: SourceFormValues[] = [];
  harness.render(
    <SourceForm
      mode="edit"
      workspaceId="ws-1"
      secretRefs={secretRefs}
      submitLabel="Save"
      initial={{ name: "Metrics", config: config(), ...initial }}
      onSubmit={async (values) => {
        submitted.push(values);
        return null;
      }}
    />,
  );
  return { harness, submitted };
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

const ready = (...refs: [string, boolean][]): GrantedSecretRefsState => ({
  state: "ready",
  refs: refs.map(([ref, configured]) => ({ ref, configured })),
});

test("a configured ref is confirmed before Test is ever pressed", async () => {
  const { harness } = await renderForm(ready(["TS_METRICS", true]), {
    secretRef: "TS_METRICS",
  });
  assert.match(harness.text(), /Credentials for TS_METRICS are configured/);
  harness.unmount();
});

test("an unconfigured ref warns with the variables to set, and still saves", async () => {
  const { harness, submitted } = await renderForm(ready(["TS_METRICS", false]), {
    secretRef: "TS_METRICS",
  });
  assert.match(harness.text(), /No credentials on the server for TS_METRICS/);
  assert.match(harness.text(), /TS_METRICS_USERNAME[\s\S]*TS_METRICS_PASSWORD/);

  harness.click(button(harness.container, "Save"));
  await settle();
  assert.equal(submitted.length, 1, "the warning did not block the save");
  assert.equal(submitted[0].secretRef, "TS_METRICS");
  harness.unmount();
});

test("a workspace granted one ref gets it without choosing", async () => {
  const { harness, submitted } = await renderForm(ready(["BILLING_RO", true]));
  assert.match(harness.text(), /Credentials for BILLING_RO are configured/);

  harness.click(button(harness.container, "Save"));
  await settle();
  assert.equal(submitted[0]?.secretRef, "BILLING_RO");
  harness.unmount();
});

test("with several granted refs nothing is chosen for the author", async () => {
  const { harness, submitted } = await renderForm(
    ready(["BILLING_RO", true], ["TS_METRICS", true]),
  );
  harness.click(button(harness.container, "Save"));
  await settle();
  assert.equal(submitted.length, 0);
  assert.match(harness.text(), /Choose the credential reference/);
  harness.unmount();
});

test("a stored ref that is no longer granted is shown as such, not replaced", async () => {
  const { harness } = await renderForm(ready(["TS_METRICS", true]), {
    secretRef: "OLD_RO",
  });
  assert.match(harness.text(), /OLD_RO \(not granted\)/);
  assert.match(harness.text(), /OLD_RO is not granted to this workspace/);
  harness.unmount();
});

test("an install that grants this workspace nothing says so and offers nothing", async () => {
  const { harness, submitted } = await renderForm(ready());
  assert.match(harness.text(), /No credential references are granted to this workspace/);
  assert.match(harness.text(), /SOURCE_SECRET_REFS/);
  assert.doesNotMatch(harness.text(), /TS_METRICS/);

  harness.click(button(harness.container, "Save"));
  await settle();
  assert.equal(submitted.length, 0);
  harness.unmount();
});
