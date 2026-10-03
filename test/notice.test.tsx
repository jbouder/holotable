import { test } from "node:test";
import assert from "node:assert/strict";
import { Notice } from "@/components/notice";
import { mount } from "./support/dom";

/**
 * The inline notice's one piece of logic (#235): it stays mounted so the
 * exit can play, and keeps the last content on screen while it does. The
 * motion itself is the `notice` utility in `globals.css`, which a DOM test
 * cannot see; what is pinned here is the markup that utility keys off.
 */

test("an open notice carries data-open and its content", async () => {
  const harness = await mount();
  harness.render(<Notice open>Saved.</Notice>);
  const el = harness.container.querySelector(".notice");
  assert.ok(el);
  assert.equal(el.getAttribute("data-open"), "true");
  assert.equal(el.textContent, "Saved.");
  harness.unmount();
});

test("closing keeps the last content on screen for the exit, without data-open", async () => {
  const harness = await mount();
  harness.render(<Notice open>Source deleted.</Notice>);
  harness.render(<Notice open={false}>{null}</Notice>);
  const el = harness.container.querySelector(".notice");
  assert.ok(el, "the element stays mounted");
  assert.equal(el.getAttribute("data-open"), null);
  assert.equal(el.textContent, "Source deleted.");
  harness.unmount();
});

test("a notice that was never open renders empty and closed", async () => {
  const harness = await mount();
  harness.render(<Notice open={false}>{null}</Notice>);
  const el = harness.container.querySelector(".notice");
  assert.ok(el);
  assert.equal(el.getAttribute("data-open"), null);
  assert.equal(el.textContent, "");
  harness.unmount();
});

test("reopening with new content replaces the remembered content", async () => {
  const harness = await mount();
  harness.render(<Notice open>First</Notice>);
  harness.render(<Notice open={false}>{null}</Notice>);
  harness.render(
    <Notice open role="status">
      Second
    </Notice>,
  );
  const el = harness.container.querySelector(".notice");
  assert.ok(el);
  assert.equal(el.textContent, "Second");
  assert.equal(el.getAttribute("role"), "status");
  harness.unmount();
});
