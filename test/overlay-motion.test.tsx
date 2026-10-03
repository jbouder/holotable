import { test } from "node:test";
import assert from "node:assert/strict";
import { mount } from "./support/dom";

// Imported after the harness has installed `window`: Base UI decides at module
// evaluation whether it is on the server, and a server never portals a popup.
const ui = async () => ({
  ...(await import("@/components/ui/dialog")),
  ...(await import("@/components/ui/menu")),
  ...(await import("@/components/ui/popover")),
  ...(await import("@/components/ui/select")),
});

/**
 * The overlay primitives' enter and exit (#235) are class names Base UI
 * keys off: `data-starting-style` on the first frame after open and
 * `data-ending-style` while closing. jsdom runs no transitions, so what can
 * be pinned here is that every popup carries both variants, from a token
 * duration, in the same spirit as `test/panel-skeleton.test.tsx`. Losing
 * either half would not fail any other test: without the starting style an
 * overlay simply pops in, and without the ending style Base UI unmounts it
 * on the spot.
 */

/** Every mounted element whose class list opts into Base UI's transition hooks. */
function transitioning(): HTMLElement[] {
  // `getAttribute`, not `className`: an SVG's className is an object.
  return [...document.body.querySelectorAll<HTMLElement>("[class]")].filter((el) =>
    (el.getAttribute("class") ?? "").includes("data-starting-style:"),
  );
}

function assertEnterAndExit(el: HTMLElement, what: string) {
  const classes = el.className;
  assert.match(
    classes,
    /data-starting-style:opacity-0/,
    `${what} enters from transparent`,
  );
  assert.match(classes, /data-ending-style:opacity-0/, `${what} leaves to transparent`);
  assert.match(
    classes,
    /duration-\(--duration-(fast|base)\)/,
    `${what} uses a token duration`,
  );
  assert.doesNotMatch(classes, /duration-\d/, `${what} has no literal duration`);
}

test("the dialog's backdrop fades and its popup fades and scales", async () => {
  const h = await mount();
  const { Dialog } = await ui();
  h.render(
    <Dialog open onOpenChange={() => undefined} title="Confirm">
      Body
    </Dialog>,
  );
  const popup = document.querySelector<HTMLElement>('[role="dialog"]');
  assert.ok(popup, "the dialog is mounted while open");
  assertEnterAndExit(popup, "the dialog popup");
  assert.match(popup.className, /data-starting-style:scale-\[0\.98\]/);
  assert.match(popup.className, /ease-emphasized/);
  const backdrop = transitioning().find(
    (el) => el !== popup && el.className.includes("inset-0"),
  );
  assert.ok(backdrop, "the backdrop opts in too");
  assertEnterAndExit(backdrop, "the backdrop");
  h.unmount();
});

test("a menu popup fades with a nudge from the side it opened on", async () => {
  const h = await mount();
  const { Menu, MenuItem } = await ui();
  h.render(
    <Menu label="Actions" trigger={<span>⋯</span>}>
      <MenuItem>Duplicate</MenuItem>
    </Menu>,
  );
  const trigger = h.container.querySelector('[aria-label="Actions"]');
  assert.ok(trigger);
  h.click(trigger);
  const popup = document.querySelector<HTMLElement>('[role="menu"]');
  assert.ok(popup, "the menu opened");
  assertEnterAndExit(popup, "the menu popup");
  assert.match(
    popup.className,
    /data-\[side=bottom\]:data-starting-style:-translate-y-1/,
  );
  assert.match(popup.className, /data-\[side=top\]:data-starting-style:translate-y-1/);
  h.unmount();
});

test("a popover popup fades with the same nudge", async () => {
  const h = await mount();
  const { Popover } = await ui();
  h.render(
    <Popover label="What this computes" trigger={<span>i</span>}>
      Explanation
    </Popover>,
  );
  const trigger = h.container.querySelector('[aria-label="What this computes"]');
  assert.ok(trigger);
  h.click(trigger);
  const popup = transitioning().find((el) => el.textContent?.includes("Explanation"));
  assert.ok(popup, "the popover opened");
  assertEnterAndExit(popup, "the popover popup");
  assert.match(
    popup.className,
    /data-\[side=bottom\]:data-starting-style:-translate-y-1/,
  );
  h.unmount();
});

test("a select popup fades and scales about its anchor", async () => {
  const h = await mount();
  const { Select } = await ui();
  h.render(
    <Select
      value="a"
      onValueChange={() => undefined}
      options={[
        { value: "a", label: "Alpha" },
        { value: "b", label: "Beta" },
      ]}
    />,
  );
  const trigger = h.container.querySelector('[role="combobox"]');
  assert.ok(trigger, "the select trigger");
  // Base UI opens a select on mousedown, not click.
  trigger.dispatchEvent(
    new window.MouseEvent("mousedown", { bubbles: true, cancelable: true }),
  );
  h.click(trigger);
  const popup = document.querySelector<HTMLElement>('[role="listbox"]');
  assert.ok(popup, "the select opened");
  assertEnterAndExit(popup, "the select popup");
  assert.match(popup.className, /data-starting-style:scale-\[0\.98\]/);
  assert.match(popup.className, /origin-\(--transform-origin\)/);
  h.unmount();
});
