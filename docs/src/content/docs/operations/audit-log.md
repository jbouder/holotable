---
title: Audit log
description: What Holotable records about who did what, how to read it, and how the table stays append-only.
---

Holotable records one row in `audit_log` for each thing someone does: signing
in and out, creating, changing or deleting a dashboard, source or template,
running a statement, asking the model for something, and every request that was
refused. The [JSON log](/operations/logging/) covers some of this too, but logs
are rotated away and a workspace admin cannot query them. This table is the
history that can't be filled in after the fact.

The table comes with migration `012_audit_log.sql`. There is nothing to
configure.

## What is recorded

| Action | When | Resource |
| --- | --- | --- |
| `auth.login` | A session is minted: the OIDC callback, or a new demo visitor | — |
| `auth.logout` | Sign-out with a session that still verifies | — |
| `auth.backchannel_logout` | The realm ends sessions (actor kind `realm`) | — |
| `authz.denied` | Any `assertAuthorized` refusal. `detail` names the `permission` and `route` | what was being acted on, when the route knows |
| `dashboard.create` | Create, import (`via: "import"`), duplicate (`via: "duplicate"`), or an MCP client's `save_dashboard` (`via: "mcp"`) | dashboard |
| `dashboard.update` | Save, rename or metadata edit (`fields`), restore (`restoredFrom`) | dashboard |
| `dashboard.delete` | Delete | dashboard |
| `dashboard.stream` | A viewer opens or resumes a dashboard's live stream | dashboard |
| `dashboard.generate` | A generation finishes, or fails (`modelConfig`: which [level](/admin/ai-provider/#models-configured-in-the-app) answered) | source |
| `dashboard.chat` | A chat turn starts (`modelConfig`, and the `timeRange`, `variables` and `panelId` it runs with) | dashboard |
| `chat.create`, `chat.update`, `chat.delete` | A [conversation](/reference/api-routes/#chat) is started (`sourceIds`, `timeRange`), renamed or changed (`renamed`, `sourceIds`, `timeRange`: what changed, never the title), or deleted (`deleted`: a count; `all` when every one went) | conversation, or — for delete-all |
| `chat.turn` | A Chat turn starts (`modelConfig`, `timeRange`, `sourceIds`) | conversation |
| `query.execute` | A statement run from preview (`via: "preview"`), by a chat (`via: "chat"`, with `conversationId` and `panelId` for Chat) or by an MCP client's `run_query` (`via: "mcp"`) | source |
| `source.create`, `source.update`, `source.delete` | Source changes, including hiding a column (`fields: ["catalog"]`) | source |
| `source.test`, `source.refresh`, `source.discover`, `source.draft` | Connection test, applied catalog refresh, table discovery, drafted source | source, or — before one exists |
| `template.create`, `template.delete` | Workspace templates | template |
| `workspace.limits.update` | A platform admin changes a workspace's LLM limits (`before`, `after`) | workspace |
| `workspace.prompt.update` | A source-admin saves a workspace's prompt customization (`glossaryChars`, `metricDefinitions`, `examples`: sizes, not the text) | workspace |
| `workspace.model.update` | A source-admin saves a workspace's [model](/admin/ai-provider/#models-configured-in-the-app) (`provider`, `baseUrlHost`, `model`, `keyChanged`, `allowPersonalKeys`, or `cleared`; never the key) | workspace |
| `workspace.model.test` | A source-admin tests a workspace model configuration (`baseUrlHost`, `model`); `failure` when the model did not answer | workspace |
| `user.model.update` | Someone saves their personal model (`provider`, `baseUrlHost`, `model`, `keyChanged`; never the key) | none |
| `user.model.delete` | Someone removes their personal model | none |
| `user.model.test` | Someone tests a personal model configuration, admitted in a workspace that allows personal keys (`baseUrlHost`, `model`) | none |
| `annotation.create` | An editor or pipeline writes an annotation (`kind`, `at`, `source`) | annotation |
| `annotation.delete` | An editor deletes an annotation | annotation |
| `share.create` | An editor creates a read-only share link (`shareId`, `expiresAt`, `allowedOrigins`, `timeRange`) | dashboard |
| `share.revoke` | An editor revokes a share link (`shareId`) | dashboard |
| `token.create` | A source-admin creates an API token (`tokenId`, `name`, `role`, `expiresAt`) | workspace |
| `token.revoke` | A source-admin revokes an API token (`tokenId`) | workspace |

`outcome` is `success`, `failure` (a statement the guard refused or the source
rejected, a failed connection test, a generation that produced nothing) or
`denied`.

### Executions

A statement is recorded when a person runs it. `/api/query` and a chat's
`runQuery` tool each write one `query.execute` row per statement. Opening a
dashboard's stream writes one `dashboard.stream` row that lists every panel's
`panelId`, `sourceId` and statement digest at the version that will run.

The shared poller's refreshes are **not** recorded one by one. Each refresh
runs the same statements on a timer for whoever is subscribed, and a row per
panel per tick would bury everything else. The stream row already says who
caused those statements to run and exactly which ones they were. A reconnect
writes a new row (`resumed: true`), because each reconnect is authorized again.

## What a row holds

| Column | |
| --- | --- |
| `id` | Increasing. Use it to page |
| `at` | When the row was written |
| `workspace_id` | The workspace the action was authorized in, taken from the stored resource. `NULL` for sign-ins and sign-outs. For a refusal it is the workspace that was targeted |
| `actor_sub`, `actor_kind` | The verified identity's subject, with kind `user`. For back-channel logout, the subject named by the realm's signed token, with kind `realm` |
| `action`, `resource_type`, `resource_id`, `outcome` | As above |
| `request_id` | The same `requestId` as the request's log lines and its error responses |
| `detail` | Context. `platformAdmin: true` when the platform-admin bypass allowed the action |

**What `detail` never holds.** `detail` goes through the same redaction as
every log line. Credential-shaped strings are scrubbed and secret-named keys
are replaced. SQL, prompts and chat messages are reduced to
`{ sha256, length }`: enough to tell that two rows ran the same statement,
nothing of what it said. A key that could hold query results (`rows`, `data`,
`values`, `result`, `records`) is dropped whatever its contents, so a metric
value cannot reach the table even if a caller passes one by mistake.

## Reading it

```http
GET /api/audit?workspaceId=&from=&to=&action=&outcome=&limit=&before=
```

- A workspace **source-admin** reads the rows of the workspaces they
  administer. `?workspaceId=` narrows that and never widens it.
- A **platform admin** reads any workspace. With no `workspaceId` they get
  every row, including sign-ins and sign-outs.
- Everyone else gets an empty list rather than a 403, so the endpoint never
  confirms that a workspace exists.
- `from` and `to` take an ISO timestamp or a relative expression such as
  `now-24h`. The server resolves them.
- `action` and `outcome` must be values from the tables above. A filter that is
  set but invalid is a 400, never ignored.
- Each page holds `limit` rows (100 by default, at most 500), newest first. The
  response's `next` is the `before` for the next page, and is `null` on the
  last page.

```json
{
  "entries": [
    {
      "id": "2",
      "at": "2026-10-04T22:31:07.412Z",
      "workspaceId": "ops",
      "actorSub": "f3c1…",
      "actorKind": "user",
      "action": "authz.denied",
      "resourceType": "source",
      "resourceId": "ts-metrics",
      "outcome": "denied",
      "requestId": "bc9bb6c8-…",
      "detail": { "permission": "source:manage", "route": "sources.delete" }
    }
  ],
  "next": null
}
```

## Append-only

Triggers on `audit_log` refuse `UPDATE`, `DELETE` and `TRUNCATE` for **every**
role, including the table's owner and a superuser. Grants alone couldn't
guarantee that: the app and the migrations connect as the same role, which
owns the table, and an owner can always grant itself back what was revoked.

If you run the app as its own role, separate from the one that runs
migrations, grant that role only what the table needs. The trigger then becomes
a second safeguard instead of the only one:

```sql
GRANT SELECT, INSERT ON audit_log TO holotable_app;
```

The triggers stop the app's own code paths, and anything that can only issue
DML, from rewriting history. They do not stop a role that owns the table and
deliberately runs DDL, because disabling a trigger is DDL. If you need
tamper-evidence against your own database administrators, copy the rows
somewhere they can't reach. A SIEM export is not built in.

## Retention

Nothing removes audit rows. Volume grows with activity: sign-ins, edits, stream
opens and statements people run, not the poller's refreshes. Pruning is a
deliberate maintenance step, run as the table's owner in one transaction so the
triggers are off only for that transaction:

```sql
BEGIN;
ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_change;
DELETE FROM audit_log WHERE at < now() - interval '400 days';
ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_change;
COMMIT;
```

`ALTER TABLE` takes an exclusive lock, so writes wait for the transaction to
finish. Keep the `DELETE` bounded.

## When a write fails

Recording an event never fails or delays the request it describes. A row that
can't be written is logged as `audit.write_failed` (or `audit.build_failed`),
and the request carries on. Each lost row also increments
`holotable_audit_write_failures_total`, so alert on it:

```text
increase(holotable_audit_write_failures_total[15m]) > 0
```

---

*Last verified against the code at commit `00ea858` (2026-10-05).*
