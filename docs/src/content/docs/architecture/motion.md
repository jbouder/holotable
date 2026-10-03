---
title: Motion
description: What moves in the interface, which platform features move it, and the one preference that gates all of it.
sidebar:
  order: 5
---

Holotable's interface animates with the platform only: CSS transitions and
keyframes, the View Transitions API, the Web Animations API, and FLIP. There
is no animation library in the dependency tree, and the rules a change has
to follow are the "Motion rules" section of `AGENTS.md`.

## One preference, one switch

The motion preference (Settings → Appearance) has three values, stored in the
browser: *Follow system*, *Reduce* and *Allow*. The root layout's inline
bootstrap script resolves it onto `<html data-motion="reduce|allow">` before
first paint, so nothing animates once and then stops. *Allow* deliberately
wins over the operating system's reduced-motion setting: the person said so
here.

Everything keys off that attribute and nothing else:

- **CSS.** One unlayered rule under `:root[data-motion="reduce"]` clamps
  every transition and animation to `0.01ms` and zeroes their delays, and a
  sibling rule silences the `::view-transition-*` pseudo-elements, which the
  first rule's `*` selector cannot reach. The clamp is not `0` on purpose:
  Base UI keeps an overlay mounted until `transitionend`, which still fires.
- **JavaScript.** Components read `useReducedMotion()`; modules without a
  render call `isMotionActive()`. Both read the same attribute. The helpers
  take an `enabled` flag from that and do nothing when it is false:
  `withViewTransition` runs its update synchronously, `animateOut` resolves
  at once, `useFlip` measures but never animates.

Under *Reduce*, therefore, every change is a cut, and the loading shimmer,
chart animation, entrances, slides and the theme crossfade are all still.

## What moves, and how

| Surface | Technique |
|---|---|
| Durations and curves | Tokens in `globals.css`: `--duration-fast/base/slow`, `--ease-standard/emphasized`; no literal durations in components |
| Dialogs, menus, popovers, selects | Base UI's `data-starting-style` / `data-ending-style` attributes, styled as Tailwind variants; Base UI holds the element until the exit transition ends |
| Theme change | A `theme` view transition: the new root snapshot fades in over the old |
| Editor/Preview and Chat/Preview tabs | A `tab` view transition: the panel crossfades and the selected tab's highlight slides |
| Cards, messages, results, alerts, icon swaps | Keyframe entrances (`stagger-in`, `drop-in`, `pop-in`) with `backwards` fill, so they share an element with hover transitions and hold nothing afterwards |
| Inline notices and banners | `Notice` over the `notice` utility: stays mounted, toggles `data-open`, exits via `display … allow-discrete` |
| Panel list, dashboard grid, dashboard list, command palette, arranger | `useFlip`: items marked `data-flip-id` slide to their new place with WAAPI; a delete runs `animateOut` first so the others close a real gap |
| Panel fullscreen | A single-element FLIP on the same card (`translate` and `scale`), so the chart is never remounted |
| Route changes | `app/template.tsx` re-mounts a `.page` element on each navigation with a keyframe entrance; the nav bar holds still |

Two consequences of the platform-only choice are worth knowing. Charts are
never recreated to animate them: a panel's card is transformed and ECharts
resizes itself to the final box (invariant 11). And view-transition names
are always scoped as `html[data-vt="<type>"] …`, where `withViewTransition`
puts the type on `<html>` for the life of the transition; the types in use
are `theme` and `tab`. Next's experimental View Transitions integration for
route changes is off: it builds, but its runtime checks were not verified,
and `template.tsx` gives the entrance without it.

## Testing it

`npm test` pins what jsdom can see: the helpers' fallbacks, `useFlip`'s
no-op and single-move paths, the `Notice` lifecycle, that every overlay
primitive carries both the starting and ending variants, and a source scan
for the rules (no `motion-safe:`, no literal durations, no animation
library, every view-transition name scoped). Whether anything moves is a
browser question, and the manual checklist in `CONTRIBUTING.md` is the
answer until an end-to-end harness exists for other reasons.
