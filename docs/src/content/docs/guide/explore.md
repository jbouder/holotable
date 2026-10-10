---
title: Explore
description: Ask questions of your data in a conversation, get answers with inline charts and tables the server ran, and add any of them to a dashboard.
---

Explore is where you ask questions of your data without building a dashboard
first. Ask in plain English; the answer comes back in words, and when a
picture answers better it comes with a **panel**: a chart, a table, a stat or
any other panel kind, drawn from rows the server just queried. Follow up and
the next answer builds on the last one. Open it from **Explore** in
the main navigation, or the command palette. A `/chat` link from before it was
named Explore lands here.

## Asking

Pick the sources the conversation may use from the chip beside the message
box, or under **Sources** in the side panel: up to three, all in one
workspace. Type a question and press **Enter** (**Shift+Enter** starts a new
line). **Stop**, or **Esc** in the box, cancels an answer that is still being
written. An empty conversation offers a few questions built from the first
source's catalog.

The answer is read-only. Explore can query the sources you picked and draw panels
from them; it cannot change a source or a dashboard. Everything it runs goes
through the same guard a dashboard panel does, over the conversation's time
range, and only over the rows you are allowed to see.

## A panel in an answer

A panel in an answer is a real panel: the same spec a dashboard holds, run on
the server. Under it:

- **Show as** draws the same rows as another kind (a line, a bar, a table…)
  without asking the model again.
- **Re-run** queries again now.
- **Add to dashboard** puts the panel, as shown, at the bottom of a dashboard
  you can edit in the source's workspace, or on a new one. It is the ordinary
  save: a new version, with every query checked again. Shown only when you can
  edit or create a dashboard there.
- **Copy spec** copies the panel as JSON, for the editor or the
  [Holotable skill](/integrations/writing-specs-with-claude-code/).
- **Show query** opens the statement, its source, and the window the server
  narrowed it to.
- A long table gets a filter box; the panel's own menu downloads CSV or PNG.

A query the model wrote in words ("Ran this query") opens the same way.

## The side panel

The side panel holds **Sources**, **History** and **Settings**. Press **[** to
show or hide it, or use the button at its top (when it is hidden, the button
stays in a narrow rail on the left). On a phone it opens from the button above
the conversation, which names the sources and the range.

**History** lists your conversations under Today, Yesterday and Earlier, each
named after its first question. Rename one, delete one, or **Delete all
conversations**. The filter searches the titles that are loaded.

**Settings**:

| Setting | What it does | Where it is kept |
| --- | --- | --- |
| Time range | The window every query in this conversation runs over. Changing it runs the panels on screen again | The conversation |
| Live refresh | Runs the panels on screen again every 30 seconds, minute or 5 minutes, skipping a hidden tab | Your preferences |
| Show queries | Opens every "Show query" and "Ran this query" by default | Your preferences |
| Keep my conversations | Keeps conversations on the server so they survive a reload and follow you to another device | Your preferences |

## What is kept

A conversation you keep is stored on the server, readable only by you; nobody
else can open it, a platform admin included. It holds your questions, the
answers and each panel's spec, **never its rows**: opening a conversation runs
its panels again. A conversation has its own address (`/explore/<id>`), so it can
be bookmarked or opened in a new tab.

Conversations are kept for `CHAT_HISTORY_RETENTION_DAYS` (30 by default) after
their last message, up to `CHAT_HISTORY_MAX_MESSAGES` messages each and
`CHAT_CONVERSATIONS_MAX` conversations per person (the least recently used go
first).

Turn **Keep my conversations** off and every kept conversation is deleted at
once; from then on a conversation lives in the page and is gone when you
leave. Its panels cannot be re-run, since nothing was stored to run.

If you lose access to a source, a conversation that used it stays in History;
with none of its sources left it opens read-only.

## Beside a dashboard

Every dashboard has a chat. Ask it what a panel means, why a number moved, or
what the data says about something the panels do not show directly, and it
answers from the panel definitions first and from fresh data when it needs it.
It is **read-only**: it cannot change the dashboard, and the only thing it can
run is the same kind of guarded query a panel runs, against the same sources.

The widget's **Open in Explore** button continues the same conversation on this
page: the dashboard's panels stay in context, its sources are the
conversation's, and the picks it was opened with show as read-only chips
beside a **From** link back to the dashboard (change them there). A panel's
menu has **Ask in Explore** as well as **Ask about this panel**: it opens that
conversation here with the question started about the panel. A dashboard's
conversation is listed in History like any other, and **Clear chat** in the
widget deletes it.

### Opening it

Press **C** anywhere on the dashboard, or use the launcher in the header.
**Esc** closes it and returns focus to where you were. The expand button docks
the chat to the right edge at full height, and this browser remembers the
choice.

An empty chat offers three or four suggested questions built from the panels
on the dashboard. They are a starting point, and they come back after **Clear
chat**.

### Asking about one panel

A panel's menu has **Ask about this panel**. It opens the chat with an "About"
chip naming the panel, so your question is read in that panel's context, and
the suggestions are about that panel. Remove the chip to ask about the
dashboard as a whole.

### What the chat sees

The chat sees the dashboard the way you do:

- **Your time window** — the one you picked in the header, or the dashboard's
  own range if you have not changed it. Shift the window and the next question
  is about the shifted window.
- **Your variable picks** — the values you have selected. A value you are not
  allowed to use is replaced by the default, and the chat is told so.
- **The panel asked about**, if any.

Every answer that fetched data says which range and which values the data was
narrowed to, so an answer and the chart beside it cannot be about different
things.

### Answers

- An answer that ran a query shows a **"ran this query"** footnote: the
  statement, the source, and which panels on the dashboard use that same
  query, with the range and values it was narrowed to.
- Answers are formatted — lists, emphasis, code and small tables — and each
  has **Copy**. The latest also has **Try again**.
- While it works, the status line says "Thinking…", then "Querying data…".
  **Stop** stops it: the model is told to stop rather than left running, and
  whatever was answered so far stays.

### Your history

A dashboard's conversation is yours: two people on the same dashboard have
separate ones and cannot see each other's. It is kept as described in
[What is kept](#what-is-kept), and **Clear chat** forgets only your own.

## Who can chat

Anyone with a viewer role in a workspace can chat over that workspace's
sources, the same access the dashboard chat has. A
row-filtered source answers with your rows only.
