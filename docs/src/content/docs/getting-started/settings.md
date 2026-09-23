---
title: Settings and your account
description: The account menu, each settings section, and which choices follow you between devices.
sidebar:
  order: 5
---

Everything that belongs to you rather than to a dashboard lives behind the
**account menu** at the right of the top bar: your initials in a round avatar,
with your name beside them on a wider screen. It holds four things:

- **Settings**, the page described below.
- **Keyboard shortcuts**, which opens the shortcuts section of Settings.
- **Theme**: Light, Dark or System. The command palette and the Appearance
  section change the same setting, and all three stay in step.
- **Sign out**.

The menu is the same at every screen width. Settings is also in the command
palette.

## Sections

`/settings` opens on Account. Every section has its own address, so you can
bookmark one or send it to someone.

| Section | Address | What it holds |
| --- | --- | --- |
| Account | `/settings/account` | Your name, email and user id, the workspaces you can reach with your role in each, and what every role allows |
| Appearance | `/settings/appearance` | Theme, and whether the interface and charts animate |
| Preferences | `/settings/preferences` | Time zone, 12 or 24 hour clock, the page you land on after signing in, and how the dashboard list opens |
| Local data | `/settings/local-data` | What this browser remembers, with a way to clear each part |
| Keyboard shortcuts | `/settings/shortcuts` | Every key binding, grouped by where it works |
| Workspaces | `/settings/workspaces` | AI usage and limits. Listed only if you are a source-admin somewhere or a platform admin |

### Account

Your name and email come from the identity provider at sign-in and are only
ever displayed. Roles come from your groups there, as described in
[Authorization model](/architecture/authorization/), and a change takes effect
the next time you sign in. When the operator sets `OIDC_ACCOUNT_URL`, a
**Manage your account** link takes you to the provider's own page for your
name, email and password.

The same information is available to scripts from `GET /api/me`.

### Appearance

**Motion** has three choices. *Follow system* respects the operating system's
reduced-motion setting. *Reduce* stops transitions, loading shimmer and chart
animation whatever the system says. *Allow* keeps them on. Charts update in
place either way.

### Preferences

**Time zone** is your browser's zone by default. UTC or any named zone can be
chosen instead. It changes how times are **shown** everywhere: dashboard
cards, the time-range picker, chart axes and tooltips, and the live clock.
Stored ranges are always UTC, and the server still decides the concrete
window a query runs over, so two people in different zones looking at the
same dashboard see the same data.

**Start page** is the dashboard list, Explore, or one dashboard you can view.
If that dashboard is deleted or you lose access to it, you land on the list
with a one-time notice instead.

**Dashboard list** defaults set the sort order and whether only your
favourites are shown. A link that names a sort or filter still wins.

### Local data

Some things are kept in the browser on purpose and never sent anywhere:
editor drafts, recent prompts, recently viewed dashboards, command palette
history, and which setup hints you dismissed. This section lists each one,
how much it holds and a button to clear it. Drafts are listed one by one and
only your own are shown, even on a shared machine. **Clear everything on this
device** asks for confirmation first.

### Workspaces

Shows each workspace's model usage today against its daily token budget and
per-minute request rate, and whether each limit comes from the environment,
is overridden for that workspace, or is off. Source-admins see their own
workspaces. Only platform admins can change an override, and the change
applies to the next model request. See
[LLM rate limits and budgets](/operations/llm-limits/).

## What follows you, and what stays on this device

| Setting | Stored | Why |
| --- | --- | --- |
| Time zone, clock, start page, dashboard list defaults | Server, per user | They are choices about you, and should survive a new laptop or a cleared browser |
| Theme, motion | This browser | They must apply before the page first draws, which cannot wait for the server. A device-specific choice is often what people want anyway |
| Drafts, recents, dismissed hints | This browser | They describe what you did on this device |

Preferences are stored per user, never per workspace, and nobody else's can be
read or changed through the API, including by a platform admin.
