import { test } from "node:test";
import assert from "node:assert/strict";
import { ProfileMenu } from "@/components/profile-menu";
import { mount } from "./support/dom";

/**
 * The header's account menu (#210). As in `test/panel-actions.test.tsx`, the
 * popup is a Base UI portal that does not mount under jsdom, so this pins the
 * trigger: one named button, showing the person's initials when there is a
 * name to take them from and a generic icon when there is not.
 */

function trigger(root: ParentNode): Element {
  const el = root.querySelector('[aria-label="Account menu"]');
  assert.ok(el, "no Account menu trigger");
  return el;
}

test("the trigger shows initials from the display name", async () => {
  const ui = await mount();
  ui.render(
    <ProfileMenu account={{ displayName: "Ada Lovelace", email: "ada@example.com" }} />,
  );
  const button = trigger(ui.container);
  assert.equal(button.textContent, "AL");
  assert.equal(button.getAttribute("aria-haspopup"), "menu");
  ui.unmount();
});

test("without a name the trigger falls back to the email, then to an icon", async () => {
  const ui = await mount();
  ui.render(<ProfileMenu account={{ displayName: null, email: "zed@example.com" }} />);
  assert.equal(trigger(ui.container).textContent, "Z");
  ui.render(<ProfileMenu account={{ displayName: null, email: null }} />);
  const button = trigger(ui.container);
  assert.equal(button.textContent, "");
  assert.ok(button.querySelector("svg"), "expected the generic user icon");
  ui.unmount();
});
