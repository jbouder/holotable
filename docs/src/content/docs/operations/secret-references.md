---
title: Source secret references
description: How a source names its credentials without ever storing them.
sidebar:
  order: 2
---

A source stores a `secret_ref` — an uppercase environment-variable family —
**never** credentials.

```
resolveCredentials("TS_METRICS")
  → reads TS_METRICS_USERNAME / TS_METRICS_PASSWORD from the environment
```

Resolution happens at execution time, on the server, and the values never reach
the database, a dashboard spec, or a client payload.

Point a `secret_ref` at your **read-only** TimescaleDB role. The app never
connects with a privileged user. See `src/lib/registry.ts`.

## Why the drafter never emits credentials

The natural-language source drafter (`/api/sources/generate`) emits only the
safe `SourceDraft` shape — connection config, table catalog, and the
`secret_ref` *name* — and is explicitly prompted to ignore any password present
in the description.

## The confusing failure mode

Credentials must already exist in the server environment for the named
`secret_ref`. A drafted or hand-created source whose `secret_ref` is
unconfigured **saves fine but fails on Test**, with:

```
credentials for secret_ref "X" are not configured in the environment
```

There is currently no indication of this before you press Test —
[#124](https://github.com/jbouder/holotable/issues/124) adds a readiness
indicator.

## Treat a draft as a starting point

Run **Test** and **Refresh** to pull the live column catalog before relying on a
drafted source. `refreshCatalog` re-reads column metadata for the tables already
in the allowlist — it never expands the set of tables generated SQL may touch.

:::note
Adding a table to a source's catalog is what grants generated SQL permission to
reference it. The allowlist is the boundary; refreshing only updates column
metadata within it.
:::
