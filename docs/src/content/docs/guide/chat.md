---
title: Chat
description: Ask questions of your data in a conversation, get answers with inline charts and tables the server ran, and add any of them to a dashboard.
---

Chat is where you ask questions of your data without building a dashboard
first. Ask in plain English; the answer comes back in words, and when a
picture answers better it comes with a **panel**: a chart, a table, a stat or
any other panel kind, drawn from rows the server just queried. Follow up and
the next answer builds on the last one. Open it from the **Chat** button on
the right of the header, or the command palette. The old `/explore` address
lands here.

## Asking

Pick the sources the conversation may use from the chip beside the message
box, or under **Sources** in the side panel: up to three, all in one
workspace. Type a question and press **Enter** (**Shift+Enter** starts a new
line). **Stop**, or **Esc** in the box, cancels an answer that is still being
written. An empty conversation offers a few questions built from the first
source's catalog.

The answer is read-only. Chat can query the sources you picked and draw panels
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
show or hide it; on a phone it opens from the button in the page header, which
names the sources and the range.

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
its panels again. A conversation has its own address (`/chat/<id>`), so it can
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

## Who can chat

Anyone with a viewer role in a workspace can chat over that workspace's
sources, the same access the [dashboard chat](/guide/dashboard-chat/) has. A
row-filtered source answers with your rows only.
