import { test } from "node:test";
import assert from "node:assert/strict";
import type { Panel } from "@/lib/ir";
import { diffPanels } from "@/lib/panel-diff";
import { PanelDiffView } from "@/components/dashboard/PanelDiffView";
import { mount } from "./support/dom";

/**
 * The review surface itself. `test/panel-diff.test.ts` pins what the diff
 * says; what needs a mount is that the surface offers no way to apply a
 * generation except the Accept button — that Accept stays disabled while the
 * object is still streaming or when there is nothing to apply, and that each
 * press of an action is exactly one call.
 */

const BEFORE: Panel = {
  id: "p1",
  title: "Requests",
  viz: "line",
  query: { sourceId: "src-1", sql: "SELECT ts, v\nFROM m", timeField: "ts" },
  layout: { x: 0, y: 0, w: 6, h: 4 },
};

const GENERATED: Panel = {
  ...BEFORE,
  title: "Request rate",
  viz: "bar",
  query: { ...BEFORE.query, sql: "SELECT ts, rate(v)\nFROM m" },
};

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const el = [...container.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes(label),
  );
  assert.ok(el, `no button labelled ${label}`);
  return el as HTMLButtonElement;
}

test("Accept is the only way to apply, and it is disabled while streaming", async () => {
  const h = await mount();
  const calls: string[] = [];
  try {
    h.render(
      <PanelDiffView
        diff={diffPanels(BEFORE, { title: "Request rate" }, { streaming: true })}
        streaming={true}
        onAccept={() => calls.push("accept")}
        onReject={() => calls.push("reject")}
        onRegenerate={() => calls.push("regenerate")}
      />,
    );
    const accept = button(h.container, "Accept");
    assert.equal(accept.disabled, true);
    h.click(accept);
    assert.deepEqual(calls, []);
    // Rejecting a run that is still streaming stays available.
    h.click(button(h.container, "Reject"));
    assert.deepEqual(calls, ["reject"]);
  } finally {
    h.unmount();
  }
});

test("each press of an action is exactly one call", async () => {
  const h = await mount();
  const calls: string[] = [];
  try {
    h.render(
      <PanelDiffView
        diff={diffPanels(BEFORE, GENERATED)}
        streaming={false}
        onAccept={() => calls.push("accept")}
        onReject={() => calls.push("reject")}
        onRegenerate={(feedback) => calls.push(`regenerate:${feedback}`)}
      />,
    );
    h.click(button(h.container, "Regenerate"));
    h.click(button(h.container, "Accept"));
    assert.deepEqual(calls, ["regenerate:", "accept"]);
  } finally {
    h.unmount();
  }
});

test("a generation with nothing to apply cannot be accepted", async () => {
  const h = await mount();
  try {
    h.render(
      <PanelDiffView
        diff={diffPanels(BEFORE, { ...BEFORE })}
        streaming={false}
        onAccept={() => {}}
        onReject={() => {}}
        onRegenerate={() => {}}
      />,
    );
    assert.equal(button(h.container, "Accept").disabled, true);
    assert.match(h.text(), /identical to the current one/);
  } finally {
    h.unmount();
  }
});

test("changed fields show, unchanged ones hide behind a toggle", async () => {
  const h = await mount();
  try {
    h.render(
      <PanelDiffView
        diff={diffPanels(BEFORE, GENERATED)}
        streaming={false}
        onAccept={() => {}}
        onReject={() => {}}
        onRegenerate={() => {}}
      />,
    );
    assert.match(h.text(), /Request rate/);
    assert.doesNotMatch(h.text(), /Time field/);
    h.click(button(h.container, "unchanged field"));
    assert.match(h.text(), /Time field/);
  } finally {
    h.unmount();
  }
});

test("the SQL diff renders both sides, marked", async () => {
  const h = await mount();
  try {
    h.render(
      <PanelDiffView
        diff={diffPanels(BEFORE, GENERATED)}
        streaming={false}
        onAccept={() => {}}
        onReject={() => {}}
        onRegenerate={() => {}}
      />,
    );
    const rows = [...h.container.querySelectorAll("pre div")].map(
      (d) => d.textContent ?? "",
    );
    assert.deepEqual(rows, ["-SELECT ts, v", "+SELECT ts, rate(v)", " FROM m"]);
    // The old JSON dump is gone: nothing renders a serialized panel.
    assert.doesNotMatch(h.text(), /"sourceId"/);
  } finally {
    h.unmount();
  }
});
