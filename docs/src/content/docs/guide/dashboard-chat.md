---
title: Dashboard chat
description: A read-only assistant beside every dashboard that answers about what is on screen, cites the queries it ran, and keeps a conversation per person.
---

Every dashboard has a chat. Ask it what a panel means, why a number moved, or
what the data says about something the panels do not show directly, and it
answers from the panel definitions first and from fresh data when it needs it.
It is **read-only**: it cannot change the dashboard, and the only thing it can
run is the same kind of guarded query a panel runs, against the same sources.

## Opening it

Press **C** anywhere on the dashboard, or use the launcher in the header.
**Esc** closes it and returns focus to where you were. The expand button docks
the chat to the right edge at full height, and this browser remembers the
choice.

An empty chat offers three or four suggested questions built from the panels
on the dashboard. They are a starting point, and they come back after **Clear
chat**.

## Asking about one panel

A panel's menu has **Ask about this panel**. It opens the chat with an "About"
chip naming the panel, so your question is read in that panel's context, and
the suggestions are about that panel. Remove the chip to ask about the
dashboard as a whole.

## What the chat sees

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

## Answers

- An answer that ran a query shows a **"ran this query"** footnote: the
  statement, the source, and which panels on the dashboard use that same
  query, with the range and values it was narrowed to.
- Answers are formatted — lists, emphasis, code and small tables — and each
  has **Copy**. The latest also has **Try again**.
- While it works, the status line says "Thinking…", then "Querying data…".
  **Stop** stops it: the model is told to stop rather than left running, and
  whatever was answered so far stays.

## Your history

A conversation is yours. Two people on the same dashboard have separate
histories and cannot see each other's. It is kept between visits, bounded in
length and in age (the operator sets both), and **Clear chat** forgets only
your own.
