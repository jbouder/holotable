---
title: Row-level filters
description: Serve several tenants from one metrics table, with each viewer limited to their own rows.
---

A source's workspace decides **who** may query it. A row filter decides
**which rows** they get back. With a filter, one metrics table can serve several
tenants: every statement run against the source sees only the rows whose filter
column matches the viewer's own value. The value comes from the viewer's
verified identity, never from the request or the model.

## Turning it on

**1. Put the tenant in the token.** Add a claim to the realm's id_token that
holds the viewer's tenant: in Keycloak, a user-attribute mapper on the
`holotable` client with *Add to ID token* on and a flat claim name such as
`tenant`. Then tell Holotable to carry that claim into its sessions:

```bash
ROW_FILTER_CLAIMS=tenant
```

`sub` is always available without listing it, for rows that belong to one
person. The server won't start if a listed name collides with a claim the
session token already uses (`sub`, `exp`, `sid`, the groups claim, `name`,
`email`, …). A claim takes effect at the viewer's next sign-in or session
renewal.

**2. Set the filter on the source.** Add `rowFilter` to the source's config:

```json
{
  "schema": "metrics",
  "rowFilter": { "column": "tenant_id", "claim": "tenant" },
  "tables": [ … ]
}
```

`column` is a bare column name that **every** table in the catalog must have.
`claim` is `sub` or a name listed in `ROW_FILTER_CLAIMS`. Saving a source that
breaks either rule fails with a 400, as does applying a catalog refresh that
drops the column from a table. The model never drafts a filter; a person sets
it.

## What the viewer sees

| The viewer's claim | Result |
| --- | --- |
| A single string or number | Only rows whose `column` equals it |
| Missing, a list, an object, empty, or over 256 characters | Refused: a 403 from preview, an error on an Explore query, and an authorization error on each of the source's panels on a dashboard. The source is never queried unfiltered |

The rule holds for platform admins too. Their bypass covers actions, not rows,
so an admin without the claim is refused like anyone else.

Pollers are shared only between viewers who would see the same rows. Viewers
with the same tenant share one poller per dashboard, and viewers from different
tenants never share one. A dashboard without a row-filtered source is shared by
everyone, as before.

## How it is enforced

The predicate is **not** added to the outer query that carries the time bounds.
That would filter only the query's output, and the output says whatever the
statement wants it to: `SELECT 'acme' AS tenant_id, sum(v) FROM m` would pass a
`tenant_id = 'acme'` check with every tenant's rows summed.

Instead, every real table the statement reads is replaced, where it appears, by
that table already narrowed to the viewer's rows:

```sql
SELECT 'acme' AS tenant_id, sum(v) FROM metrics.m h
-- runs as
SELECT 'acme' AS tenant_id, sum(v)
  FROM (SELECT * FROM "metrics"."m" AS _holo_rf
         WHERE _holo_rf.tenant_id = $3) h
```

The value is a bound parameter. Every table is narrowed, wherever it appears:
in a CTE body, a subquery, a join, either side of a `UNION`, or a `TABLE m`.
Nothing the statement does with the results can reach another tenant's rows,
because those rows never reach it. PostgreSQL pushes the condition down to the
table, so an index on the filter column is used as usual.

The rewrite uses the SQL guard's own parse tree to decide which names are real
tables and which are CTE names. It then parses the rewritten statement again
and checks that every table read has the filter. A statement that fails that
check is refused, never run. On a filtered source, the guard also refuses three
things: `ONLY` and `TABLESAMPLE`, which apply to a table rather than to the
subquery that stands in for it, and the alias `_holo_rf`, which the rewrite
reserves.

`/api/sql/plan` shows the rewritten statement and labels the extra parameter
`your "tenant" claim`, so an editor can see what will run.

## On a Prometheus source

A Prometheus source's row filter is a **tenant label**, `{ "label": "tenant",
"claim": "tenant" }`, set in the source form or its JSON (#385, #386). Every
selector a PromQL query holds, including those inside subqueries and function
arguments, is narrowed to `tenant="<the viewer's value>"` before it is sent.
A query that matches on the tenant label itself is refused rather than
overridden. The label has to be one every allowlisted metric lists, which the
save checks the way it checks a column on every table. A label-values variable
lists only the values under the same matcher.

## Limits

- **One value per viewer.** A viewer who belongs to several tenants needs a
  claim naming one of them. A list is refused rather than resolved by picking
  one.
- **No column-level control.** A row filter limits rows; which columns a viewer
  sees is set by the catalog's per-column exposure.
- **Belt and braces.** This is enforced in Holotable. If the metrics database
  already enforces tenancy with its own row-level security policies, keep them:
  the two do not conflict.

---

*Last verified against the code at commit `00ea858` (2026-10-05).*
