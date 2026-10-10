---
title: Annotations
description: Deploys, incidents and notes drawn on time-series panels, kept to their workspace.
sidebar:
  order: 8
---

A latency spike reads differently next to the deploy that caused it.
**Annotations** ([#68](https://github.com/jbouder/holotable/issues/68)) are events
a person or a pipeline writes into a workspace. Every time-series panel (`line`,
`area`, `bar` with a `query.timeField`) on that workspace's dashboards draws
them: a dashed line for a point in time, a band for a range.

| Field | Meaning |
| --- | --- |
| `at` | ISO-8601 instant. |
| `endedAt` | Optional. Makes it a range: an incident, a maintenance window. Not before `at`. |
| `kind` | `deploy` (`info`), `incident` (`danger`) or `note` (`neutral`): the color is a token (invariant 13). |
| `title` | 1–200 characters. Shown when the mark is hovered. |
| `description` | Optional, up to 2,000 characters. |
| `tags` | Up to 10, letters, digits and `_ . : -`. A dashboard can show only some tags. |
| `source` | Optional: the pipeline that wrote it. `manual` from the dashboard. |

## Writing and reading

- **Write:** `POST /api/workspaces/<workspace>/annotations` with the fields above,
  or **Add annotation** under the flag in a dashboard's header. Editor role in
  that workspace. `DELETE /api/workspaces/<workspace>/annotations/<id>` removes
  one. Both are audited (`annotation.create`, `annotation.delete`).
- **Read:** `GET /api/dashboards/<id>/annotations?from=&to=`, viewer role. The
  workspace is the dashboard record's own, so a dashboard can only ever show its
  own workspace's annotations, and the server resolves the window like every
  other (invariant 8). It is widened to cover any panel with a window of its own.
  The open dashboard reads again every minute and whenever the window changes.

A pipeline posts deploy markers with an editor
[API token](/integrations/api-tokens/) (#288); the write route authorizes it
through `can()` like anyone else.

## On a dashboard

- **Dashboard setting.** The editor's **Annotations** card can turn them off for
  a dashboard, or limit it to some tags. Stored as `annotations: { show, tags }`
  in the spec.
- **Viewer toggle.** The flag control lists the annotations in the window and
  hides them from this view without changing the dashboard.
- **Charts merge.** Marks ride on the first series as `markLine` and `markArea`.
  Hiding them sets empty lists, so the merge clears them and the chart is never
  recreated (invariant 11).
- **Placement.** A time axis is one category per row, so an instant is drawn at
  the first row at or after it. One outside the rows is left off, and a range is
  clipped to them.
