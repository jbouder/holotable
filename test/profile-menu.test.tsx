import { test } from "node:test";
import assert from "node:assert/strict";
import { ProfileMenu } from "@/components/profile-menu";
import { mount } from "./support/dom";

/**
 * The header's account menu (#210). As in `test/panel-actions.test.tsx`, the
 * popup is a Base UI portal that does not mount under jsdom, so this pins the
 * trigger: one named button showing who is signed in without opening it —
 * the initials beside the name, the email when there is no name, and a generic
 * icon when there is neither. The visible name leads the accessible name, so
 * what a sighted user reads is what a voice-control user says.
 */

function trigger(root: ParentNode): Element {
  const el = root.querySelector('[aria-haspopup="menu"]');
  assert.ok(el, "no account menu trigger");
  return el;
}

test("the trigger shows the display name beside its initials", async () => {
  const ui = await mount();
  ui.render(
    <ProfileMenu account={{ displayName: "Ada Lovelace", email: "ada@example.com" }} />,
  );
  const button = trigger(ui.container);
  assert.equal(button.textContent, "ALAda Lovelace");
  assert.equal(button.getAttribute("aria-label"), "Ada Lovelace, account menu");
  ui.unmount();
});

test("without a name the trigger falls back to the email, then to an icon", async () => {
  const ui = await mount();
  ui.render(<ProfileMenu account={{ displayName: null, email: "zed@example.com" }} />);
  let button = trigger(ui.container);
  assert.equal(button.textContent, "Zzed@example.com");
  assert.equal(button.getAttribute("aria-label"), "zed@example.com, account menu");
  ui.render(<ProfileMenu account={{ displayName: null, email: null }} />);
  button = trigger(ui.container);
  assert.equal(button.textContent, "");
  assert.equal(button.getAttribute("aria-label"), "Account menu");
  // The avatar's own icon, not the chevron beside it.
  assert.ok(button.querySelector("span > svg"), "expected the generic user icon");
  ui.unmount();
});
