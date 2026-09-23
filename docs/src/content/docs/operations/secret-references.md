---
title: Source secret references
description: How a source names its credentials without ever storing them, and which workspaces may use which.
sidebar:
  order: 2
---

A source stores a `secret_ref` — an uppercase name like `TS_METRICS` —
**never** credentials. The server turns the name into a username and a
password at execution time, and only for a workspace the operator has granted
that name to.

```
resolveCredentials("TS_METRICS", workspace)
  → is TS_METRICS granted to this workspace by SOURCE_SECRET_REFS?   no → refused
  → TS_METRICS_USERNAME / TS_METRICS_PASSWORD
      as files in SOURCE_SECRETS_DIR, if both are there
      otherwise from the environment
```

The values never reach the database, a dashboard spec, or a client payload.
Point a `secret_ref` at your **read-only** TimescaleDB role; the app never
connects with a privileged user. See `src/lib/secrets/credentials.ts`.

## Granting refs to workspaces

`SOURCE_SECRET_REFS` declares which workspace may use which ref:

```bash
SOURCE_SECRET_REFS="TS_METRICS:ops,platform; BILLING_RO:finance; SHARED_RO:*"
```

Entries are separated by `;` or a newline, each a ref, a colon, and a
comma-separated list of workspace ids — the `<id>` in the
`/workspaces/<id>/<role>` groups a user carries. `*` alone grants a ref to
every workspace, for a single-tenant install.

Without it, refs would be global: a `source-admin` in one workspace could
create a source naming another workspace's ref and query that database with
its role. The grant is what ties a database account to the workspaces meant
to use it.

It **fails closed**:

- **Unset grants nothing.** No source resolves credentials. A production
  server refuses to start with a message naming the variable; development
  starts with a warning. Set it to the empty string if no source is
  configured yet.
- **A malformed value grants nothing**, and is an error at startup in every
  environment. A duplicate ref, an empty workspace list, or `*` mixed with
  names is refused rather than guessed at.
- **The grant is checked on every connection** — execution, **Test**,
  **Refresh** and table discovery — not only when a source is saved. A source
  whose ref was granted when it was created, and has since been withdrawn,
  stops connecting. So does a source record written to the database some other
  way.

Creating or editing a source, or discovering tables, with a ref the workspace
is not granted is refused with a `400` that names `SOURCE_SECRET_REFS`.

## Where the credentials live

For a granted ref `TS_METRICS`, the server reads `TS_METRICS_USERNAME` and
`TS_METRICS_PASSWORD`:

1. **As files in `SOURCE_SECRETS_DIR`**, when it is set and both files exist.
   The files are read on every connection, so a new ref or a rotated password
   takes effect with **no restart**. One trailing newline is dropped. If only
   one of the two files is there, resolution is refused rather than completed
   from the environment.
2. **Otherwise from the environment.** The environment is fixed when the
   process starts, so adding or rotating a pair this way needs a restart.

On Kubernetes, set `sourceSecrets.secretName` in the chart to a Secret whose
keys are those names. The chart mounts it as a volume and sets
`SOURCE_SECRETS_DIR`. The kubelet refreshes a mounted Secret in place within
about a minute; see [Kubernetes](/operations/kubernetes/).

## Readiness, before you press Test

The source form's `secret_ref` field is a picker over the refs granted to the
workspace, each with whether the server holds credentials for it:

- a green check — ready;
- a warning naming the two variables to set (`X_USERNAME`, `X_PASSWORD`) —
  granted, but no credentials yet. Saving is still allowed: the credentials
  are the operator's to set, and they may well land after the source does;
- **not granted** — a stored source whose ref is no longer granted to its
  workspace. It cannot connect until an operator grants it again.

A workspace granted exactly one ref gets it without choosing. A workspace
granted none says so, and names `SOURCE_SECRET_REFS`. The source list shows the
same states per row.

Behind it is `GET /api/secret-refs?workspaceId=…`, which requires
`source:manage` in that workspace, is rate limited per caller, and answers
`{ refs: [{ ref, configured }] }`: only the refs granted to that workspace,
each with a boolean. Nobody can ask about a name of their choosing, or learn
which refs other workspaces hold. `configured` is what `resolveCredentials`
would do, found by calling it, so the indicator and execution can never
disagree.

At startup the server also checks every live source, and warns about any
whose ref is not granted to its workspace or does not resolve (see
[Startup validation](/operations/startup-validation/)).

## Upgrading

`SOURCE_SECRET_REFS` became required when grants were introduced. Before
upgrading an existing deployment, list which workspace uses which ref:

```sql
SELECT DISTINCT secret_ref, workspace_id FROM sources WHERE tombstoned_at IS NULL;
```

and declare exactly those. Declaring them with `*` restores the old behaviour,
where any workspace could use any ref, and is what the grant exists to replace.

## Why the drafter never emits credentials

The natural-language source drafter (`/api/sources/generate`) emits only the
safe `SourceDraft` shape: connection config, table catalog, and the
`secret_ref` *name*. It is told which refs the workspace is granted, and is
explicitly prompted to ignore any password in the description. The prompt is
advice; creating the source is what refuses an ungranted ref.

## Treat a draft as a starting point

Run **Test** and **Refresh** to pull the live column catalog before relying on a
drafted source. `refreshCatalog` re-reads column metadata for the tables already
in the allowlist — it never expands the set of tables generated SQL may touch.

:::note
Adding a table to a source's catalog is what grants generated SQL permission to
reference it. The allowlist is the boundary; refreshing only updates column
metadata within it.
:::
