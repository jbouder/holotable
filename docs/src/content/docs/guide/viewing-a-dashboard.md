---
title: Viewing a dashboard
description: The time picker, pausing, the connection indicator, each panel's menu with fullscreen and exports, and the command palette.
---

A dashboard is live from the moment it opens: the panels fill, the header says
**Live**, and every panel refreshes on its own cadence without you doing
anything. This page is what you can do from there. Nothing on it runs the
model, and nothing asks the server for a row the panels are not already
showing. What happens underneath — one shared poller per dashboard, and charts
that merge new rows rather than redraw — is
[Streaming and rendering](/concepts/streaming-and-rendering/).

## Choosing the time window

The time picker in the header sets the window every panel shows. There are
three ways to say it:

- **Quick ranges**: 15 minutes to 7 days, relative to now, so the window rolls
  forward as data arrives.
- **Last N**: a width of your own, in minutes, hours, days or weeks, still
  relative to now.
- **Absolute**: a start and an end, entered in your own time zone.

Once a window is chosen, **shift back** and **shift forward** move it by its
own width and **zoom out** doubles it. Shifting forward past now snaps back to
a rolling window of the same width, which is how you return to live after
going to look at yesterday.

Two more ways to choose a window are on the charts themselves. **Drag across**
a line, area or bar chart to make the stretch you covered the dashboard's
window. And panels share a **crosshair**: hover one chart and the others mark
the same moment.

An absolute window is a *fixed range*, and the picker badges it that way. The
panels keep refreshing, but they show the same seconds each time, so "no new
data" is what to expect; the badge offers the way back to a rolling window.

The window is part of the page URL, so copying the address bar gives someone a
link to exactly what you are looking at. A dashboard opened without one uses
its own default range, which is set in the editor.

## Pausing

**Pause** in the header stops updates; **Resume** picks them up again, and the
panels catch up on what they missed. Paused is its own muted state in the
indicator, not a lost connection, and an error on a panel still shows while
paused because it is still true. In the hosted demo, a tab left alone for a
while pauses itself; Resume brings it back.

## The connection indicator

The header indicator says whether the dashboard is live, reconnecting, paused
or disconnected, and how long ago data last arrived — counting up for the
first minute, then as a clock time. That clock is about the data, not the
connection: a reconnect does not reset it, so a number that is three minutes
old says so even after the stream comes back.

A dropped stream reconnects by itself and names each attempt. If the retries
keep failing, a **Reconnect** button appears. When your session has ended, the
sign-in banner says so instead; sign in again and the dashboard resumes where
it was. Screen readers hear a state change as one sentence, not a stream of
counting seconds.

## A panel's menu

Every panel has a menu (the ⋯ in its header), and the info control beside the
title shows the one-sentence description of what the panel computes.

- **Show query** opens the panel's statement — SQL or PromQL — with its source
  and time field, or for PromQL how it is evaluated. It is not offered on a
  text panel or through a share link.
- **Ask about this panel** opens the [dashboard chat](/guide/chat/#beside-a-dashboard)
  with the panel attached to your question.
- The panel's **links**, if the editor gave it any, lead to another dashboard
  carrying your window and picks; see [Drilldown](/guide/drilldown/).
- **Fullscreen** expands the panel over the whole viewport. Escape closes it
  and puts focus back where it was.
- **Export CSV** saves the rows the panel is showing right now, ready for a
  spreadsheet. A text value a spreadsheet would run as a formula is escaped,
  since the values come from a database Holotable does not own; numbers are
  never changed.
- **Export PNG** saves the chart as an image on the theme's background. Stat
  and table panels offer CSV only.

An export is always the window the panel already holds. It cannot reach a row
the panel was not showing, and it is not a way to run a query.

## Finding things: Cmd/Ctrl+K

Press `⌘K` (`Ctrl+K` elsewhere) anywhere in the app to open the command
palette. Start typing to find a dashboard or a data source by name, jump to one
of the app's pages, or run an action: new dashboard, new source, switch the
theme, or refresh a source's catalog if you administer it. The commands you
use most lead the list before you type; once you type, the best match leads.

It only ever shows what you could already open from the sidebar, in the
workspaces you belong to.

## Asking about it

The chat beside every dashboard answers questions about what is on screen,
with the same window and picks you are viewing. It is read-only and has its
own page: [Dashboard chat](/guide/chat/#beside-a-dashboard).
