import { JSDOM } from "jsdom";
import type * as React from "react";

/**
 * Minimal DOM harness for the component tests.
 *
 * The rest of the suite is pure logic under `node:test`, but an error boundary
 * cannot be exercised without a real React unwind: `react-dom/server` does not
 * run boundaries at all — a throwing child propagates straight out of
 * `renderToStaticMarkup` — so the only way to assert that one bad panel does
 * not take the dashboard with it is to mount it. jsdom is a devDependency and
 * never reaches the build.
 */

export interface Mounted {
  container: HTMLElement;
  /** Render (or re-render) `ui` and flush effects. */
  render(ui: React.ReactNode): void;
  /** Dispatch a click and flush the resulting render. */
  click(el: Element): void;
  /** Dispatch a keydown and flush the resulting render. */
  key(el: Element, key: string, init?: { shiftKey?: boolean }): void;
  unmount(): void;
  text(): string;
}

/** Errors React logged to the console during the most recent mount. */
export interface Harness extends Mounted {
  consoleErrors: string[];
}

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});

// React and jsdom both read these off globalThis. Installed once for the
// process; `mount()` gives each test its own container underneath.
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
// Node 22 defines a getter-only global `navigator`; overwrite it outright.
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.MouseEvent = dom.window.MouseEvent;
g.KeyboardEvent = dom.window.KeyboardEvent;
g.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
g.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
// Base UI positions a popup against its trigger, and reads the trigger's
// computed style to do it — asynchronously, so a missing global surfaces as an
// unhandled rejection after the test has already passed.
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
// ECharts and the chart wrapper observe their container; jsdom has no
// ResizeObserver and the panels under test never need a real one.
g.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
// React 19 checks this to decide whether act() is allowed.
g.IS_REACT_ACT_ENVIRONMENT = true;

/** Mount a fresh container. Call `unmount()` when the test is done. */
export async function mount(): Promise<Harness> {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");

  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);

  // A boundary that catches logs the error; that is React working, not a test
  // failure, so capture it rather than let it flood the reporter.
  const consoleErrors: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(" "));
  };

  return {
    container: container as unknown as HTMLElement,
    consoleErrors,
    render(ui) {
      void act(() => {
        root.render(ui);
      });
    },
    click(el) {
      void act(() => {
        el.dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      });
    },
    key(el, key, init) {
      void act(() => {
        el.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
            ...init,
          }),
        );
      });
    },
    unmount() {
      void act(() => {
        root.unmount();
      });
      container.remove();
      console.error = realError;
    },
    text() {
      return container.textContent ?? "";
    },
  };
}
