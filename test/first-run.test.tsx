import { test } from "node:test";
import assert from "node:assert/strict";
import { FirstRun } from "@/components/onboarding/first-run";
import { onboardingState } from "@/lib/onboarding";
import { mount } from "./support/dom";

/**
 * While the setup guide is up it is the page: "Welcome to Holotable" is the
 * only `h1` and the dashboard list's own header is held back. Dismissing the
 * guide happens in the browser without a reload, so the header is handed in
 * and drawn here; a page notice is drawn in every state.
 */

const editor = onboardingState({
  sources: [],
  dashboardCount: 0,
  canManageSources: true,
  canCreateDashboards: true,
});
const viewer = onboardingState({
  sources: [],
  dashboardCount: 0,
  canManageSources: false,
  canCreateDashboards: false,
});

const header = <h1 data-testid="page-header">Dashboards</h1>;
const banner = <div data-testid="banner">notice</div>;

function headings(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll("h1"), (h) => h.textContent ?? "");
}

test("the guide replaces the page header and keeps the banner", async () => {
  const ui = await mount();
  ui.render(
    <FirstRun state={editor} dismissed={false} header={header} banner={banner} />,
  );
  assert.deepEqual(headings(ui.container), ["Welcome to Holotable"]);
  assert.ok(ui.container.querySelector('[data-testid="banner"]'));
  ui.unmount();
});

test("once dismissed, the page header comes back above the empty state", async () => {
  const ui = await mount();
  ui.render(<FirstRun state={editor} dismissed header={header} banner={banner} />);
  assert.deepEqual(headings(ui.container), ["Dashboards"]);
  assert.ok(ui.container.querySelector('[data-testid="banner"]'));
  assert.match(ui.container.textContent ?? "", /No dashboards yet/);
  ui.unmount();
});

test("a reader who cannot act gets the page header, not the guide", async () => {
  const ui = await mount();
  assert.equal(viewer.actionable, false);
  ui.render(
    <FirstRun state={viewer} dismissed={false} header={header} banner={banner} />,
  );
  assert.deepEqual(headings(ui.container), ["Dashboards"]);
  ui.unmount();
});
