import { test } from "node:test";
import assert from "node:assert/strict";
import { AppearanceSettings } from "@/components/settings/appearance-settings";
import { mount } from "./support/dom";

/**
 * The appearance controls (#212): two native radio groups, each named by its
 * legend, that apply the choice to `<html>` and store it at the click.
 */

// jsdom has no matchMedia; the preferences only need `matches` and listeners.
// Installed before any render, which is when the components first read it.
const w = globalThis.window as unknown as Record<string, unknown>;
w.matchMedia = (query: string) => ({
  matches: query.includes("reduced-motion"),
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

function radios(root: ParentNode, name: string): HTMLInputElement[] {
  return [
    ...root.querySelectorAll(`input[type="radio"][name="${name}"]`),
  ] as HTMLInputElement[];
}

test("each group is a fieldset named by its legend, every radio labelled", async () => {
  const ui = await mount();
  ui.render(<AppearanceSettings />);
  const legends = [...ui.container.querySelectorAll("fieldset > legend")].map(
    (l) => l.textContent,
  );
  assert.deepEqual(legends, ["Theme", "Motion"]);
  for (const name of ["theme", "motion"]) {
    const group = radios(ui.container, name);
    assert.equal(group.length, 3);
    for (const radio of group) {
      assert.ok(
        radio.closest("label")?.textContent?.trim(),
        `${name}=${radio.value} has no label`,
      );
    }
  }
  ui.unmount();
});

test("choosing applies to <html> at once and is remembered", async () => {
  window.localStorage.clear();
  const ui = await mount();
  ui.render(<AppearanceSettings />);
  const html = document.documentElement;

  ui.click(radios(ui.container, "theme").find((r) => r.value === "light") as Element);
  assert.equal(html.dataset.theme, "light");
  assert.equal(window.localStorage.getItem("theme"), "light");

  ui.click(radios(ui.container, "motion").find((r) => r.value === "allow") as Element);
  assert.equal(html.dataset.motion, "allow");
  assert.equal(window.localStorage.getItem("motion"), "allow");
  assert.equal(radios(ui.container, "motion").find((r) => r.checked)?.value, "allow");

  // Follow system resolves through the OS query, which the stub says reduces.
  ui.click(radios(ui.container, "motion").find((r) => r.value === "system") as Element);
  assert.equal(html.dataset.motion, "reduce");
  ui.unmount();
});
