---
title: Drilldown
description: Panel links that lead from one dashboard to another, carrying the viewer's window and picks, with every target and every pick checked on the server.
sidebar:
  order: 9
---

A panel can declare **links**: where it leads when a viewer wants to look
closer. A link opens another dashboard in the same workspace, or stays on this
one and sets a variable ("click to filter"). The viewer's time range and
variable picks go along, so landing on the host dashboard from the fleet
overview keeps the window they were looking at.

Drilldown is being built in phases under
[#370](https://github.com/jbouder/holotable/issues/370). Today a panel's links
are followed from its menu. Clicking a point, slice, cell or row to follow a
link that reads it comes with
[#373](https://github.com/jbouder/holotable/issues/373).

## What a link is

A link is part of the spec, in the panel's `links` array, so it is versioned,
diffed and exported with everything else. See
[The shared IR](/concepts/the-shared-ir/#links) for the fields.

```json
{
  "title": "Host detail",
  "dashboard": "9b2c41d0-…",
  "carry": { "timeRange": true, "variables": true },
  "set": { "env": { "value": "prod" } }
}
```

- **The target is an id.** `dashboard` is the target's id, never a URL. With
  no `dashboard`, the link stays on this dashboard.
- **What it carries.** By default the viewer's current window and every pick
  go along. `carry.timeRange: false` lands on the target's own default window;
  `carry.variables: false` lands on its own default picks.
- **What it sets.** `set` makes picks on arrival. A literal
  (`{ "value": "prod" }`) wins over a carried pick of the same name.

## What a viewer sees

A panel with a link the viewer can follow shows a small link glyph in its
header, and each link is an item in the panel's ⋯ menu:

- **A link to another dashboard** is a real link to that dashboard's page,
  opened in this tab or, with `newTab`, a new one.
- **A self link** sets the variables in place. The picker, the URL and the
  stream change as they would for a pick made by hand, and the page does not
  navigate.
- **A link the viewer cannot follow** is a disabled item that says the
  dashboard is not available. The page holds no href for it.

## Who decides where a link may lead

The dashboard page resolves the targets on the server, on every load. A target
is offered only when it:

1. exists and has not been deleted,
2. is in the **same workspace** as the dashboard the link is on, and
3. is one the viewer may view (`can("dashboard:view")`).

The browser builds hrefs only to the targets the server named. Nothing about
the decision is read from the spec: an id in a link is a candidate, and a link
never reaches across workspaces, even to a dashboard the viewer could open
there.

An href carries the IR's time expressions (`now-6h`) and `var-*` picks, never
SQL and never a resolved instant. The target page treats it exactly like a URL
typed by hand: the server resolves the window, and every pick is checked
against the target's own variable before anything runs with it. A pick the
target does not allow falls back to its default, and a name it does not declare
is ignored.

## Where links do not appear

- **A share link or embed** shows no links. The other side has no session to
  open a dashboard with.
- **Explore** panels have none: an explored panel is on no dashboard.
- **Templates.** Saving a dashboard as a template keeps its self links and drops
  links to other dashboards, whose ids mean nothing where the template is used.
  A panel template keeps no links.
- **Import.** An imported file keeps its links. Ids from another instance
  resolve to nothing here, so those links show as unavailable; the import dialog
  says how many dashboards the file links to.

Deleting a dashboard leaves the links to it in place. They turn disabled.
