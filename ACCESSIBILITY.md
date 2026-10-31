# Accessibility

Holotable aims to conform to **WCAG 2.2 Level AA**, in every shipped theme and
both color schemes, from phone width up. It **partially conforms**: a few
known exceptions remain, each with an issue.

The full statement is on the docs site:
[**Accessibility statement**](https://holotable-docs.vibeproject.workers.dev/reference/accessibility/)
(source: `docs/src/content/docs/reference/accessibility.md`). It says what is
covered, every automated and manual check and where it runs, the other way to
do each drag, and the known exceptions. This page only points there, so the
two cannot disagree.

## How it is held

Every pull request that changes code runs axe-core (the WCAG 2.0, 2.1 and 2.2
A and AA rules) over every main surface, on a desktop and on an emulated
phone, along with keyboard, focus and reflow checks. Any violation fails, and
`End-to-end and accessibility` is a required check on `main`. Contrast, the
focus ring and every theme's colors are measured by unit tests in `npm test`.

## Reporting a problem

Open an issue and add the `area:a11y` label. Say what you were doing, what you
expected, and what assistive technology, browser and operating system you
used, if any. A barrier that stops someone using a feature is treated as a
bug, not an enhancement.
