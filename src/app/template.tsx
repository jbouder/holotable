import type * as React from "react";

/**
 * The route entrance (#238). Next re-mounts a template on every navigation
 * at its segment, so the `.page` element is new each time and its keyframe
 * entrance in `globals.css` plays again. The nav bar is in the layout,
 * outside this, and holds still. There is no exit: the old page is gone
 * before the new one mounts, and animating that needs the View Transitions
 * integration, which is experimental in Next 16 and deliberately not on.
 *
 * It is a flex column filling `main`, so a page whose root is `flex-1` can
 * give one box the rest of the viewport (the generation canvases' placeholder).
 */
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="page flex flex-1 flex-col">{children}</div>;
}
