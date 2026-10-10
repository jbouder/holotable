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
[#370](https://github.com/jbouder/holotable/issues/370). A link that only
carries the view is followed from the panel's menu. A link that reads what was
clicked is followed by clicking a point, slice, cell or row
([#373](https://github.com/jbouder/holotable/issues/373)).

## What a link is

A link is part of the spec, in the panel's `links` array, so it is versioned,
diffed and exported with everything else. Authors edit links in the editor's
[Links section](/guide/editing-a-dashboard/#links). See
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

## Clicking a datum

A link whose `set` reads a `column` (`{ "column": "host" }`), the series
(`{ "series": true }`) or one label of the series (`{ "label": "instance" }`)
is a **datum link**. It needs to know what was clicked,
so it is not in the panel's menu. Instead the panel's data is clickable:

- **A chart.** Click a point, bar, slice, cell, span or gauge. With one link,
  the click follows it. With several, a small list opens at the point, and
  Escape or a click outside closes it. A click that ends a time brush never
  follows a link.
- **A table.** Each row has a link control in a trailing cell; the row itself
  stays text to read and copy.
- **A stat.** The whole number is the control.
- **The keyboard.** Every chart has a visually hidden table of its rows. With
  datum links, each row there has the same link control, and the table shows
  itself over the chart while one has focus.

A click is mapped back to the result row the panel already holds
(`datumOf` in `src/lib/drilldown-datum.ts`, one mapping per panel kind). No
query runs. A `column` pick reads that column of the row. A `series` pick reads
the series: the column a line, area or bar point belongs to, a slice's label, a
heatmap cell's y value, a timeline's lane or a gauge bar's label. A value the
row does not have, or one longer than a pick may be, leaves that variable
unset, and the target falls back to its default.

On a PromQL panel (#388), an instant query's table or pie has a column per
label, so a `column` pick reads a label by name. A range query's chart has one
series per label set, named the way the Prometheus UI names a legend entry,
`up{instance="web-01:9100", job="node"}`, and a `series` pick carries that whole
name. A `label` pick reads one label out of it (`seriesLabel` in
`src/lib/drilldown.ts`), so "click a host's line, land on the host dashboard"
needs no parsing in the link: `{ "host": { "label": "instance" } }` sets `host`
to `web-01:9100`. A series without that label leaves the pick unset.

A **self datum link** filters in place: clicking a host's slice sets `host` on
this dashboard, the picker and the URL follow, and the picker puts it back.

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
- **Explore** panels have none: a panel in an answer is on no dashboard. Add it to one and give it links in the editor.
- **Templates.** Saving a dashboard as a template keeps its self links and drops
  links to other dashboards, whose ids mean nothing where the template is used.
  A panel template keeps no links.
- **Import.** An imported file keeps its links. Ids from another instance
  resolve to nothing here, so those links show as unavailable; the import dialog
  says how many dashboards the file links to.

Deleting a dashboard leaves the links to it in place. They turn disabled.
