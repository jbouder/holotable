import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { useFlip } from "@/components/use-flip";
import { mount } from "./support/dom";

/**
 * What `useFlip` (#237) has to be true of in jsdom, which has neither
 * `Element.animate` nor real layout: it measures without throwing whether or
 * not it is enabled, and it never reaches for `animate` unless an item has
 * actually moved — so a browser without WAAPI, or a test, just gets the cut.
 */

function List({ ids, enabled }: { ids: string[]; enabled: boolean }) {
  const ref = React.useRef<HTMLUListElement>(null);
  useFlip(ref, enabled, { durationMs: 100 });
  return (
    <ul ref={ref}>
      {ids.map((id) => (
        <li key={id} data-flip-id={id}>
          {id}
        </li>
      ))}
    </ul>
  );
}

test("a reorder renders without throwing when disabled", async () => {
  const h = await mount();
  h.render(<List ids={["a", "b", "c"]} enabled={false} />);
  h.render(<List ids={["c", "a", "b"]} enabled={false} />);
  assert.equal(h.text(), "cab");
  h.unmount();
});

test("a reorder renders without throwing when enabled and nothing can animate", async () => {
  const h = await mount();
  h.render(<List ids={["a", "b", "c"]} enabled />);
  h.render(<List ids={["b", "c", "a"]} enabled />);
  h.render(<List ids={["b", "c"]} enabled />);
  assert.equal(h.text(), "bc");
  h.unmount();
});

test("an item that moved is animated from its old place when it can be", async () => {
  const h = await mount();
  h.render(<List ids={["a", "b"]} enabled />);
  const items = [...h.container.querySelectorAll<HTMLElement>("[data-flip-id]")];
  // Fake layout: `a` sits at the top on the first measure and 40px lower on
  // the next, and `animate` records what it was asked for.
  const calls: { keyframes: unknown; options: unknown }[] = [];
  let top = 0;
  for (const el of items) {
    el.getBoundingClientRect = () =>
      ({ left: 0, top: el.dataset.flipId === "a" ? top : 100 }) as DOMRect;
    el.animate = ((keyframes: unknown, options: unknown) => {
      calls.push({ keyframes, options });
      return { playState: "running", cancel() {} } as unknown as Animation;
    }) as typeof el.animate;
  }
  // Re-measure with the fakes in place (that render sees `b` jump from
  // jsdom's zero to the faked 100, which is noise), then move `a`.
  h.render(<List ids={["a", "b"]} enabled />);
  calls.length = 0;
  top = 40;
  h.render(<List ids={["a", "b"]} enabled />);
  assert.equal(calls.length, 1, "only the item that moved is animated");
  assert.deepEqual(calls[0].keyframes, [
    { translate: "0px -40px" },
    { translate: "0 0" },
  ]);
  assert.deepEqual(calls[0].options, {
    duration: 100,
    easing: "cubic-bezier(0.2, 0, 0, 1)",
  });
  h.unmount();
});
