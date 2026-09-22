---
title: Your first dashboard
description: From an empty install to a live dashboard over your own TimescaleDB, in three steps.
sidebar:
  order: 3
---

[Quick start](/getting-started/quick-start/) gets the app running. This page
gets you a dashboard — over **your** database, not the seeded demo. It is the
same three steps the app walks you through on a fresh install, in the same
order, so you can follow either one.

Before you begin you need the app running and signed in, an `AI_PROVIDER` and
`AI_MODEL` configured (see [AI provider](/operations/ai-provider/)), and a
**read-only** PostgreSQL or TimescaleDB role that can reach the tables you want
to watch. You also need the `source-admin` role in a workspace for steps 1 and
2, and `editor` for step 3; see the
[Authorization model](/architecture/authorization/).

## The one thing to understand first

The model never sees a single row of your data. It is shown the *catalog* — the
tables and columns you allowed, and nothing else — and it answers with a
validated dashboard spec: what to compute, and how to draw it. The server takes
that spec, guards the SQL, injects the time window, runs it against your
database, and streams the numbers back. On every refresh it runs the SQL again;
it does not ask the model again.

That is why the next two steps exist. The catalog is what the model reads, so
it has to be true before anything it writes can work. See
[How it works](/concepts/how-it-works/).

## 1. Connect a data source

**Data sources → Add source.**

A source is the connection Holotable is allowed to read: host, port, database,
schema, and the list of tables. Fill the form, or describe the database in
plain English and let the drafter fill it for you — either way you review the
values before they are saved.

The one field that is not a connection detail is **secret reference**. It is a
name, like `TS_METRICS`, not a credential. Holotable reads
`TS_METRICS_USERNAME` and `TS_METRICS_PASSWORD` from the *server environment*
at execution time. Nothing about your password is stored in the source, in a
dashboard, or in anything sent to the browser. Set the two variables where the
server can see them — your `.env`, your container environment, your Kubernetes
secret — and restart if the server was already running.

The form tells you, as you type the name, whether the server currently holds
credentials for it. A green check means step 2 will work. A warning names the
two variables to set.

**This guards against:** a dashboard that carries a password. See
[Source secret references](/operations/secret-references/).

**Success looks like:** a row in the source list.

## 2. Test and refresh the catalog

Two buttons on that row, in this order.

**Test** opens a connection with the resolved credentials and closes it. It
answers one question: can the server actually reach this database as this role?
A failure here is a credential or a network problem, and it is much easier to
read now than as a broken panel later.

**Refresh** introspects the schema and records the columns and types of every
allowlisted table. This is what the model is shown. Refresh does not widen
anything — it never adds a table you did not list, it only makes what you did
list accurate. A table you allowed that the database no longer has is reported
as missing rather than quietly kept.

**This guards against:** SQL written against columns that do not exist. Until a
refresh has run, generating against the source is *refused* rather than
attempted — an unverified catalog is a guess, and the failure would land on you
as a broken chart instead of a sentence.

**Success looks like:** the Catalog column reads *Catalog fresh*, and the row's
table count matches what you expect.

## 3. Generate your first dashboard

**Dashboards → New dashboard.**

Pick the source. Describe what you want to watch in plain English — the starter
chips under the box are built from your own catalog, so they name your tables,
not a demo's. Something concrete works better than something broad:

> Request volume over time and the five slowest routes, plus a stat panel with
> the total error count

Press send. The spec streams in and the preview fills as it arrives. Follow-ups
refine it — "make the third one a bar chart", "add a 95th percentile line" —
and each one is a single model call that returns the whole dashboard again.
Nothing is written until you press **Save**.

Saving takes you to the live view: the server opens one stream for the whole
dashboard, runs the guarded SQL on the refresh interval, and merges each tick
into the charts. The model is not involved again.

**This guards against:** committing to a dashboard you have not looked at.
Generation, refinement and preview all happen before anything is persisted, so
a first attempt that misreads what you meant costs a follow-up rather than a
saved version you now have to clean up.

**Success looks like:** charts that keep moving, and a green connection dot.

## When it doesn't work

**"Generation is unavailable" or a 500 on send.** No AI provider is configured.
`AI_PROVIDER` and `AI_MODEL` must be set, with the matching key. See
[AI provider](/operations/ai-provider/).

**`credentials for secret_ref "X" are not configured in the environment`.** The
source names a secret reference the server has no values for. Set `X_USERNAME`
and `X_PASSWORD` in the server's environment and restart it. See
[Source secret references](/operations/secret-references/).

**"The catalog has never been checked against the database."** Step 2 was
skipped. Press Refresh on the source. See
[Generating a panel](/concepts/generating-a-panel/).

**A panel fails with an error naming a table.** The table is not in the
source's allowlist. Refreshing does not add it — the allowlist is the boundary,
and widening it is an edit to the source. Edit the source, add the table, then
Refresh. See
[Source secret references](/operations/secret-references/).

**A query was rejected before it ran.** The SQL guard refused it: it allows one
read-only `SELECT`, over allowlisted relations, with no comments, no
non-deterministic functions, and the server's own time bounds. Ask for the
panel a different way, or look at what the guard objects to in
[Executing a panel](/concepts/executing-a-panel/).

**The source list says a table is missing.** The database no longer has a table
you allowlisted. Edit the source to drop it, or restore it in the database.

## Next

- [Demo data](/getting-started/demo-data/) — a seeded workspace to compare against.
- [How it works](/concepts/how-it-works/) — the path from prompt to live chart.
- [Invariants](/architecture/invariants/) — the guarantees behind every step above.
