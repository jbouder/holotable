---
title: Viewing a dashboard
description: The connection indicator, the time picker, pausing, fullscreen and exports, the command palette, and the read-only chat beside every dashboard.
---

Opening a dashboard attaches the browser to the one shared poller for it and
replays the stored spec; how that works is
[Streaming and rendering](/concepts/streaming-and-rendering/). This page is
what the viewer can do with it. Nothing here runs the model, and nothing
here asks the server for a row the panels were not already showing.

## Connection state

`EventSource` retries forever and says nothing about it, so a dead stream and a
slow one look the same. `LiveDashboard` therefore tracks the connection
separately from panel data, through the reducer in `src/lib/connection.ts`:
`connecting` → `live` → `reconnecting` → `failed`, plus `paused`.

The header indicator shows that state, names the attempt while reconnecting,
and reports how long ago data last arrived — counting up for the first minute,
then an absolute clock time. Once the automatic retries have failed
`MANUAL_RECONNECT_AFTER_ATTEMPTS` times, or the browser gives up outright
(`readyState === CLOSED`, typically an expired session), a manual **Reconnect**
appears; it replaces the `EventSource`, which is the only way to shortcut the
browser's own retry schedule. The whole indicator is one polite `aria-live`
region carrying a full sentence, so a state change is announced rather than a
stream of counting seconds.

A reopened socket does **not** reset the freshness clock: it answers "how old
is this number", not "how old is this connection".

## Choosing the window

The header's time picker offers three ways to say the same thing, plus shift
and zoom over whatever is currently chosen:

- **Quick ranges** — the five presets (15m … 7d), all relative to `now`.
- **Last N** — a custom relative width in minutes, hours, days or weeks.
- **Absolute** — two `datetime-local` instants, entered and displayed in the
  reader's own zone and stored as UTC ISO-8601.
- **Shift back / forward** moves the window by its own width; **zoom out**
  doubles it. Shifting forward past `now` snaps back to the rolling window of
  the same width, which is how a reader who went looking at yesterday returns
  to live.
- **Brushing** a line, area or bar panel that has a `timeField` selects the
  stretch of time the drag covered and makes it the dashboard's window.
  `brushedRange` reads the timestamps of the first and last rows the selection
  covered; a selection it cannot read leaves the window alone rather than
  guessing at one. Only kinds whose registry entry sets `timeBrush` (line,
  area and bar) are brushable; on the rest the x-axis is not time laid out
  left to right, or there is no axis at all.
- Panels on one dashboard share a **crosshair**: moving the pointer over one
  chart moves the axis pointer on the others. This is done by forwarding the
  hovered category index between the instances, not with `echarts.connect`,
  which mirrors *every* connected action — a brush included — and would make
  one drag produce a selection on every panel.

Everything the picker emits is a pair of IR `TimeExpr` strings. The client is
never the authority on the window that was queried: the expressions go out on
the stream URL, the route re-parses them against `TimeRange`, and the poller
calls `resolveTimeRange` itself on every tick (invariant 4). A window that
`TimeRange` refuses is a `400` on the stream and falls back to the dashboard's
own range on the page.

An **absolute** window is frozen by definition — the poller keeps ticking, but
it re-queries the same seconds — so the picker badges it *Fixed range* and
offers a way back, and the staleness watchdog is switched off for it. "No new
data" is the correct state there, not a stale one.

The chosen window is written into the URL with `history.replaceState`, so a
range is a link someone can send. It is `replaceState` and not a Next
navigation because re-rendering the server page would remount the viewer and
tear down the `EventSource` on every change. The dashboard's own range is left
out of the query string, so the default link stays clean.

## Pausing

The viewer can pause live updates. The Pause/Resume toggle closes the
`EventSource`; resuming reattaches to the shared poller. While paused, the
transient `live` and `loading` badges are suppressed — they no longer reflect
reality — but error and tombstone states remain meaningful. Paused reads as a
distinct, muted state in the indicator; it is not the same thing as a dropped
stream.

## Fullscreen and export

Each panel's header carries an overflow menu (the ⋯ trigger). Besides
**Show query**, which opens the panel's statement (SQL or PromQL), source and
time field, or for PromQL how it is evaluated, in a dialog (not offered for a text panel or through a share link), and
**Ask about this panel** (#366) and the panel's links (see
[Drilldown](/guide/drilldown/)), it holds three local actions (#76):

- **Fullscreen** expands the panel over the viewport. It is not a portal: the
  same card simply becomes `fixed`, so the panel's position in the React tree
  never changes and the ECharts instance is *resized* by the `ResizeObserver`
  already in `EChart` rather than disposed and rebuilt. Escape closes it and
  focus returns to whatever opened it.
- **Export CSV** serializes the window the panel is currently holding — RFC
  4180 quoting, CRLF, a UTF-8 BOM so Excel reads it as UTF-8. A *text* cell
  that starts with `=`, `+`, `-`, `@` or a tab is prefixed with an apostrophe,
  because a spreadsheet would otherwise run it as a formula and the values come
  from a database Holotable does not own. Numbers are never touched.
- **Export PNG** comes out of the ECharts instance with the theme's surface
  color painted behind it, since the canvas itself is transparent. Stat and
  table panels are offered the CSV alone.

None of the three asks the server for anything. An export therefore cannot
contain a row the panel was not already showing, and cannot become a second,
unguarded way to run a query. Exporting the **full** result set server-side is
a different feature and is not this one.

## Getting around: Cmd/Ctrl+K

`CommandPalette` (`src/components/command-palette.tsx`) is mounted in the root
layout for a signed-in identity and opens anywhere in the app. It lists
dashboards, data sources, the app's pages, and a handful of actions — new
dashboard, new source, the theme, and a catalog refresh for a source the caller
administers.

It is a navigator, not a second API surface. Results come from
`GET /api/search`, whose candidate workspaces come from the validated claims:
there is no workspace parameter, so nothing in the query string can widen what
comes back, and a result is by construction somewhere the identity could
already go. A source is projected to its id, name and workspace —
`SourceRecord` carries the connection config and the catalog, and neither has
any business in a search result (invariant 5). The one action that is not
navigation opens the same reviewed refresh the source list uses: a diff from
the guarded `/api/sources/[id]/refresh`, and nothing written until it is
applied. The route checks `source:manage` for itself.

Matching and ordering live in `src/lib/command-palette.ts` as pure functions
over a payload and a query, which is what makes them testable. Actions are
*data* — a tagged union the component switches on — rather than callbacks, so a
command can be ranked, compared and remembered. Recently-used commands are kept
in `localStorage` and lead the list before anything is typed; once something is
typed the score decides and recency only breaks ties. A remembered id is
treated as untrusted: it can name a command, never reach one.

The listbox follows the APG combobox pattern rather than a menu — real focus
stays in the text field and `aria-activedescendant` points at the selection —
because a menu would move focus out of the box being typed into.

## Dashboard chat

The viewer also includes a **read-only** chat assistant scoped to one dashboard.
It reasons over the panel specs first and may escalate to fetching fresh data
through a guarded `runQuery` tool.

The tool is scoped to the sources the dashboard already references *and* the
caller may use — each re-resolved and re-authorized, with unavailable ones
silently omitted, mirroring the poller's tombstone handling. It runs the same
`validateSql` → `buildExecutablePlan` → `executePlan` pipeline, injects the
time range **the reader is viewing**, caps rows (`MAX_TOOL_ROWS`) and model-tool
steps, and cannot mutate the dashboard. The model still authors SQL, never data.

### Answers are about what is on screen

Each question carries the reader's view (#366), so the chat and the charts
cannot disagree about which window or which slice they mean:

- **The range.** The browser reads `from`/`to` from the URL `LiveDashboard`
  keeps on the window being viewed; none means the dashboard's own range. The
  route parses it as an IR time expression and resolves it on the server, the
  same as the stream; a range that does not resolve is a 400.
- **The variable picks.** The `var-*` values go through `checkedSelection`,
  the stream's allowlist, under the reader's row scope. A value the reader may
  not use does not fail the question: the turn runs with the defaults, and the
  prompt tells the model so. Values reach the prompt inside a fenced
  `VARIABLES` block, as untrusted text, and are still bound as parameters.
- **The panel asked about.** A panel's menu has **Ask about this panel**,
  which opens the chat with a removable "About" chip. Only the panel's id is
  sent; the server looks it up in the stored spec and ignores an id that is not
  on the dashboard. The browser never supplies SQL.

The route records the range, values and panel on the `dashboard.chat` audit
event, and each `runQuery` result reports the range and values it was narrowed
to, which the citation shows.

### Using it

These make it usable rather than a demo (#82, #366):

- **History persists.** A turn is stored in `chat_messages`, keyed by
  `(dashboard_id, user_sub, id)` — the SDK's own message id, so re-sending a
  turn updates the row rather than appending a duplicate. A conversation is one
  reader working something out, so it is scoped per person: two people on the
  same dashboard have separate histories and cannot see each other's. It is
  bounded by `CHAT_HISTORY_MAX_MESSAGES` and `CHAT_HISTORY_RETENTION_DAYS`,
  enforced on write *and* on read, so lowering either takes effect at once
  rather than whenever someone next sends a message. The sweep runs in the same
  transaction as the write, which is what keeps the table bounded without a
  scheduled job. Clearing the chat is a `DELETE` on the same route, and forgets
  only the caller's own conversation.

  Stored rows are read back as untrusted: `content` is opaque JSONB holding a
  shape the SDK owns and evolves, so `parseStoredMessage` shape-checks each one
  and drops what no longer parses. A conversation that starts a turn shorter
  beats one that replays something half-understood into a prompt.

- **Answers cite their queries.** An assistant message that called `runQuery`
  renders an expandable "ran this query" footnote with the source id and the
  statement, plus the titles of any panels whose own query is the same
  statement. It is read off the message's own tool parts, which the SDK already
  streamed to the browser — no second request, and nothing the client is told
  that it was not already holding. The footnote names the range and variable
  values the server narrowed the rows to, rather than showing a statement that
  is neither what the model wrote nor what the database saw.

- **Answers are formatted.** Assistant text goes through the same sanitized
  Markdown subset a text panel uses (`src/lib/markdown.ts`): lists, emphasis,
  code and small tables, built as React elements, never an HTML string. A
  reader's own message stays plain text.

- **Suggestions are derived, not generated, and start a conversation.**
  `chatSuggestions` builds three or four questions from the panel titles and
  viz kinds on the server; `panelChatSuggestions` does the same for the panel
  asked about. A second model call to decide what to ask a model would cost a
  round trip and a budget entry to produce three sentences, and would be
  different every time. They show on an empty chat only, and again after
  **Clear chat**.

- **It gets out of the way.** **C** opens it from anywhere on the dashboard
  and **Esc** closes it, returning focus to the launcher. The expand button
  docks it to the right edge at full height; the choice is kept in this
  browser (`holotable:chat-expanded`). Each answer has **Copy**, and the last
  one **Try again**. While it works it shows the same pulsing-compass status
  line as Explore and a new dashboard: "Thinking…", then "Querying data…".

- **Stop actually stops.** The route passes the request's own `AbortSignal` into
  `streamText`, so a browser that presses stop cancels the provider call instead
  of leaving it generating — and billing — for an answer nobody is reading.
  `onEnd` still fires on that path, so the partial answer is stored.
