---
title: API routes
description: Every HTTP route, what it does, and the role it requires.
sidebar:
  order: 3
---

All routes run on the Node runtime. Every route below **Auth** and
**Operations** resolves identity with `requireIdentity()` and authorizes
through `can()`; see [Authorization model](/architecture/authorization/).
A [service-account API token](/operations/api-tokens/) is accepted wherever a
session is, except the dashboard stream. A [share link](/operations/share-links/)
is accepted only by the stream.

`test/docs-drift.test.ts` holds this page to the route files: every route
under `src/app/api/` and every method it exports has a row here, and every row
names one that exists.

## Dashboards

| Route | Method | Min role | Notes |
| --- | --- | --- | --- |
| `/api/dashboards` | GET | viewer | List dashboards. `?workspaceId=` and `?editable=true` only **narrow** the caller's own workspaces — the candidates come from the claims and each is re-checked with `can()` |
| `/api/dashboards` | POST | editor | Create; validates the spec and derives the workspace from trusted sources. A spec of an earlier `specVersion` (or none) is upgraded first, and the row is written at the current one |
| `/api/dashboards/[id]` | GET | viewer | Current version with its spec |
| `/api/dashboards/[id]` | PUT | editor | Appends a **new immutable version**, at the current `specVersion`; an older spec is upgraded first |
| `/api/dashboards/[id]` | PATCH | editor | Metadata. `description` and `tags` are written to the row in place; a `title` appends a **version**, because the spec owns the name |
| `/api/dashboards/[id]` | DELETE | owner / source-admin | Soft delete |
| `/api/dashboards/[id]/duplicate` | POST | viewer + editor | Copies the current spec into a new dashboard at version 1, titled `"… (copy)"`. Re-validates the spec, so a copy of a dashboard whose source was tombstoned fails loudly |
| `/api/dashboards/[id]/favorite` | PUT / DELETE | viewer | Star or unstar it **for the caller**. No body: the subject is always the session's own |
| `/api/dashboards/[id]/export` | GET | viewer | Downloads the current spec as a JSON file (`Content-Disposition: attachment`). Carries source **ids** only — no workspace, author, or connection detail |
| `/api/dashboards/[id]/versions` | GET | viewer | The version history, newest first, **without specs**: number, author `sub`, time, note, panel count. Keyset-paginated with `?before=<version>&limit=` (default 20, max 100); also returns `current` |
| `/api/dashboards/[id]/versions/[version]` | GET | viewer | One version with its spec, upgraded in memory to the current `specVersion` |
| `/api/dashboards/[id]/versions/[version]/restore` | POST | editor | Appends a **new version** copying that version's spec, noted `restored from vN`. Never repoints or edits an old row. The copy goes through the same source and SQL checks as a save, so a version reading a since-removed source, table or hidden column is refused (400) |
| `/api/dashboards/import` | POST | editor | Creates a dashboard at version 1 from an exported file. The target workspace is a request field re-checked by `can()`; source ids are re-pointed by an **explicit** mapping and any still unresolved refuse the whole import |
| `/api/dashboards/[id]/stream` | GET | viewer | SSE deltas, cookie-authenticated, or `?share=<token>` for a [share link](/operations/share-links/), which ignores `from`/`to` and `var-*`. `from`/`to` pick the window; `var-<name>` (repeated for a multi-value variable) picks variable values, each checked against what the variable allows this viewer, or a `400` |
| `/api/dashboards/[id]/shares` | GET, POST | editor | List the dashboard's [share links](/operations/share-links/), or create one; the token is in the create response only |
| `/api/dashboards/[id]/shares/[shareId]` | DELETE | editor | Revoke a share link at once; its open streams close |
| `/api/dashboards/[id]/annotations` | GET | viewer | The [annotations](/concepts/annotations/) the dashboard shows for `from`/`to` (its own range by default), from the dashboard's own workspace only, honoring its `annotations` setting |
| `/api/dashboards/[id]/panels/[panelId]/retry` | POST | viewer | Runs a panel the poller is backing off from now instead of at its `retryAt`, on every poller showing the dashboard. Refused (`started: 0`) for a panel that is not backing off or within `MIN_REFRESH_INTERVAL_MS` of its last attempt. The result arrives on the stream |
| `/api/dashboards/[id]/chat` | POST | viewer | Read-only chat with a guarded `runQuery` tool. Rate limited and budgeted. The turn is persisted for the **caller's own** subject and the request's abort signal cancels the model call |
| `/api/dashboards/[id]/chat` | GET | viewer | The caller's own stored conversation on this dashboard, bounded by `CHAT_HISTORY_MAX_MESSAGES` / `CHAT_HISTORY_RETENTION_DAYS`. The subject comes from the session, never from the request |
| `/api/dashboards/[id]/chat` | DELETE | viewer | Forget the caller's own conversation on this dashboard. Nobody else's |

## Templates

A template is a reusable `Panel` or `Dashboard` spec, workspace-scoped and
authorized exactly like the dashboards it is made of — there is no `template:*`
vocabulary in `can()`, because a template carries no capability its dashboard
did not.

| Route | Method | Min role | Notes |
| --- | --- | --- | --- |
| `/api/templates` | GET | viewer | Templates saved in a workspace. `?kind=panel\|dashboard` narrows; `?sourceId=` additionally returns the **built-in** golden-signal starters parameterized by that source's catalog |
| `/api/templates` | POST | editor | Save a panel or dashboard as a template. The body is put through the same `resolveAndValidateDashboard` a save uses, so every statement is re-guarded and the workspace must match the one derived from the sources. `409` when the workspace already has that name |
| `/api/templates/[id]` | DELETE | owner / source-admin | Hard delete — instantiating a template copies its spec, so nothing points back at the row |

There is deliberately **no instantiate route**. Applying a template re-points
its panels at a source the user picks, re-checks each statement through
`/api/sql/validate`, and then goes out through the ordinary create or save,
so a dashboard built from a template is indistinguishable from one built by
hand.

## Generation and query

| Route | Method | Min role | Notes |
| --- | --- | --- | --- |
| `/api/generate` | POST | editor | Streams a validated dashboard, panel, or explore-panel spec. Authorized against the workspace owning the selected **source**. The `dashboard` and `dashboard-refine` modes take up to two `additionalSourceIds` in that workspace ([ADR 1](/architecture/decisions/0001-multi-source-generation/)); each is authorized and checked on its own record, and one that fails refuses the request. Refuses with a 400 when a source's catalog was never refreshed or names nothing that still exists. Rate limited and budgeted. A first attempt carries `X-Generation-Id`; `{ "repairOf": id }` asks for its one [repair](/operations/ai-provider/#structured-output-repair), and is a 404 once taken or expired |
| `/api/query` | POST | editor | One-shot guarded query for preview and Explore. `variables` carries the values a preview binds for `:name` references, only ever as parameters |
| `/api/sql/validate` | POST | editor | Runs the SQL guard against a source's catalog without executing. Always `200`; the verdict is `{ ok, error? }`. `variables` names the dashboard's declared variables, which `:name` may reference |
| `/api/sql/plan` | POST | editor | The statement exactly as the server would run it, without running it: the wrapped SQL, the bound parameters with what each was resolved from, the limits and the session statements. A refused statement is a `400` with the guard's message. See [Seeing what actually runs](/concepts/executing-a-panel/#seeing-what-actually-runs) |
| `/api/variables/options` | POST | editor | The values a [dashboard variable](/concepts/variables/) allows, from its declaration: an `enum`'s list, or a `query` variable's guarded SELECT run as the caller. Audited as `query.execute` |
| `/api/generation-log` | GET | source-admin | The redacted prompt/spec pairs every generation leaves behind. Workspaces come from the caller's claims, so `?workspaceId=` narrows and can never widen; a viewer or editor reads an empty list rather than a 403. `?limit=` is clamped |
| `/api/audit` | GET | source-admin | The append-only [audit log](/operations/audit-log/), newest first. Filters: `workspaceId`, `from`/`to` (ISO or `now-24h`), `action`, `outcome`; paged with `limit` and `before` (the previous page's `next`). Workspaces come from the caller's claims as above; a platform admin reads any workspace, and every row with no filter. An unusable filter is a 400 |

## Sources

| Route | Method | Min role | Notes |
| --- | --- | --- | --- |
| `/api/sources` | GET | viewer | List sources in a workspace, each with its catalog health. A source admin gets full records; anyone else gets a listing (id, name, schema, table count, status) with no connection details, `secret_ref` or catalog. `canManage` says which |
| `/api/sources` | POST | source-admin | Create |
| `/api/sources/generate` | POST | editor | Streams a validated `SourceDraft` — never credentials. Rate limited and budgeted. Takes `{ "repairOf": id }` for the one [repair](/operations/ai-provider/#structured-output-repair), as `/api/generate` does |
| `/api/sources/[id]` | GET | viewer | The full record for a source admin, the listing for anyone else |
| `/api/sources/[id]` | PUT/DELETE | source-admin | Delete tombstones when referenced |
| `/api/sources/[id]/catalog` | GET | viewer | The catalog browser's view: every column with its `exposed` flag for a source admin, exposed columns only for anyone else, plus catalog health |
| `/api/sources/[id]/catalog/impact` | GET | source-admin | `?table=&column=`: the current panels on this source that hiding the column would break, decided by a dry run of the guard. Ids and titles only, never SQL, scoped to the source's workspace |
| `/api/sources/[id]/catalog` | PATCH | source-admin | Hide or expose one column, `{ table, column, exposed }`. Takes effect on the next generation and execution |
| `/api/sources/[id]/impact` | GET | source-admin | Dashboards and panels currently referencing the source, scoped to its workspace |
| `/api/sources/[id]/test` | POST | source-admin | Connectivity, latency, server and role identity, a **read-only proof**, and per-table reachability. All of it inside one rolled-back read-only transaction |
| `/api/sources/discover` | POST | source-admin | The tables and columns a prospective source's read-only user can see, to pick an allowlist from. Nothing is persisted, and the `secret_ref` grant is checked like any connection |
| `/api/secret-refs` | GET | source-admin | `?workspaceId=`: the `secret_ref`s granted to that workspace, each with whether the server holds credentials. Names and booleans only, rate limited per caller. See [Source secret references](/operations/secret-references/) |
| `/api/sources/[id]/refresh` | POST | source-admin | Re-introspect the catalog. With `{}` it is a preview: it writes nothing and answers with the diff and a `digest`. With `{ digest }` it introspects again and writes only if the result matches, recording freshness and any allowlisted table the database no longer has; otherwise 409 with the new diff and digest |

## Search

| Route | Method | Min role | Notes |
| --- | --- | --- | --- |
| `/api/search` | GET | viewer | What the command palette searches. Dashboards and sources across every workspace the caller can already reach, taken from the claims — there is **no** workspace parameter to widen it. A source is projected to its id, name, workspace and whether the caller may manage it; the connection config and the catalog never leave the server |

## Account

| Route | Method | Min role | Notes |
| --- | --- | --- | --- |
| `/api/me` | GET | signed in | The caller's own subject, display name, email, platform-admin flag and workspace roles, all from the session. No parameters, so it can only describe the identity that asked. The name and email are display-only and never reach `can()` |
| `/api/me/preferences` | GET / PATCH | signed in | The caller's own preferences: time zone, clock, start page and dashboard list defaults. PATCH merges a partial object; an unknown key or an invalid value is a 400 naming the field, and a start dashboard must be one the caller can view. No subject parameter, so nobody reads or writes another person's row |

## Workspaces

| Route | Method | Min role | Notes |
| --- | --- | --- | --- |
| `/api/workspaces/[id]/limits` | PATCH | platform admin | Set or clear the workspace's `ratePerMinute` and `dailyTokenBudget` overrides in `workspace_limits`. A present key is written, `null` inherits the environment's value again, `0` disables the limit, and an absent key is left alone. Gated on `workspace:limits`, which no workspace role grants. Each change writes a `workspace_limits.changed` log line and a `workspace.limits.update` audit row, both with the before and after values. Answers with the workspace's effective limits and today's usage; the next model call uses them, with no restart |
| `/api/workspaces/[id]/prompt` | GET, PUT | editor (GET), source-admin (PUT) | The workspace's [prompt customization](/concepts/generating-a-panel/#workspace-context): `{ glossary, metricDefinitions, examples }`. GET is gated on `dashboard:generate`, PUT on `source:manage`, both in the path's workspace. PUT replaces the whole customization; an example whose panel fails the IR, runs no query, or whose SQL fails the guard against its source (which must be live and in this workspace) is a `400` naming the example. Audited as `workspace.prompt.update`, with the sizes, never the text |
| `/api/workspaces/[id]/prompt/preview` | GET | editor | `?sourceId=` — the system prompt a generation against that source is given, composed as `/api/generate` composes it. The source must belong to the path's workspace, by its own record; otherwise `404` |
| `/api/workspaces/[id]/annotations` | POST | editor | Write an [annotation](/concepts/annotations/) into the workspace in the path: `{ at, endedAt?, kind, title, description?, tags?, source? }`. Audited as `annotation.create` |
| `/api/workspaces/[id]/annotations/[annotationId]` | DELETE | editor | Delete one of that workspace's annotations; another workspace's id is a `404`. Audited as `annotation.delete` |
| `/api/workspaces/[id]/tokens` | GET, POST | source-admin | List the workspace's [API tokens](/operations/api-tokens/), or create one (`{ name, role, expiresInDays }`); the token is in the create response only. Audited as `token.create` |
| `/api/workspaces/[id]/tokens/[tokenId]` | DELETE | source-admin | Revoke a token; refused from its next request. Audited as `token.revoke` |

## MCP clients

| Route | Method | Min role | Notes |
| --- | --- | --- | --- |
| `/api/mcp` | GET, POST | signed in (bearer) | The [MCP server](/operations/mcp/) ([#148](https://github.com/jbouder/holotable/issues/148)). POST is the protocol: JSON-RPC over the stateless streamable HTTP transport (`initialize`, `ping`, `tools/list`, `tools/call`), each tool authorized with `can()` for the bearer's identity exactly as the route it mirrors. The one route that accepts a realm-issued access token, in `Authorization: Bearer`, and the only credential it accepts besides a service-account `ht_` token: no session cookie ([#149](https://github.com/jbouder/holotable/issues/149)). Unauthenticated, or refused, is a `401` whose `WWW-Authenticate` names the protected-resource metadata at `/.well-known/oauth-protected-resource/api/mcp`; see [Keycloak setup](/operations/keycloak/#5-mcp-clients). GET answers with the caller's identity as `/api/me` does (a `405` when asked for an event stream). A `404` until `OIDC_MCP_CLIENT_ID` is set, and always in demo mode

## Auth

| Route | Method | Notes |
| --- | --- | --- |
| `/api/auth/login` | GET | Begins the OIDC authorization-code flow |
| `/api/auth/callback` | GET | Verifies the token, mints the session cookie |
| `/api/auth/refresh` | POST | Renews the session (#27). Authenticated by the `/api/auth`-scoped renewal cookie, not the session cookie, so it works after the token expired. Re-derives groups from the realm's fresh id_token. `200 { expiresAt }`; `401` when there is nothing to renew or the realm refused (both cookies cleared); `503` when the realm or database did not answer. A 404 in demo mode |
| `/api/auth/logout` | POST | Clears both session cookies, deletes the stored refresh token, and revokes the session's token so a copy of the cookie stops working |
| `/api/auth/backchannel-logout` | POST | Called by Keycloak, not a browser (#28). Form body `logout_token`, verified against the realm JWKS for issuer, audience (`OIDC_CLIENT_ID`), age and the back-channel `events` claim. Revokes the named `sid` (or every session of a bare `sub`), closes its open streams, deletes its `sessions` rows. `200` empty, or `400 {"error":"invalid_request"}`. A 404 in demo mode or without OIDC |

## Operations

These three are outside the session: a probe and a scraper do not hold a
cookie.

| Route | Method | Access | Notes |
| --- | --- | --- | --- |
| `/api/health` | GET | open | Liveness. Always `200` while the process serves; carries the build identity |
| `/api/ready` | GET | open | Readiness. Does I/O and fails while draining. See [Health and readiness](/operations/health-checks/) |
| `/api/metrics` | GET | token and/or CIDR | Prometheus exposition format. `404` until configured. See [Prometheus metrics](/operations/metrics/) |

## Error contract

Statement-level SQL failures return **400** with the real message so an editor
can correct and retry. Connection and infrastructure failures return a generic
**500** and are never surfaced. This split is
[invariant 16](/architecture/invariants/#16-statement-errors-are-actionable-infrastructure-errors-are-opaque).

| Status | Meaning |
| --- | --- |
| 400 | Invalid request, invalid spec, rejected SQL, or a failed statement |
| 401 | No valid session |
| 403 | Authenticated but not authorized for the action |
| 404 | Resource not found |
| 409 | Source is tombstoned, or a template name is already taken in the workspace |
| 429 | A model-backed route hit the workspace's rate limit or token budget; the message says which and when it resets, and `Retry-After` is set. See [LLM rate limits and budgets](/operations/llm-limits/) |
| 500 | Infrastructure failure — deliberately opaque |

Every error body is `{ error, kind, requestId }`. `kind` is one of
`validation`, `statement`, `authorization`, `not_found`, `conflict`,
`rate_limit`, or `infrastructure`, and it is what a client presents from — a
`400` is both a rejected body and a failed statement, and only the route knows
which. `requestId` is the same value as the `x-request-id` header, repeated in
the body so the opaque path has something the user can quote back.
