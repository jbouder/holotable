---
title: API routes
description: Every HTTP route, what it does, and the role it requires.
sidebar:
  order: 3
---

All routes run on the Node runtime. Every one resolves identity with
`requireIdentity()` and authorizes through `can()` — see
[Authorization model](/architecture/authorization/).

## Dashboards

| Route | Method | Min role | Notes |
| --- | --- | --- | --- |
| `/api/dashboards` | GET | viewer | List dashboards. `?workspaceId=` and `?editable=true` only **narrow** the caller's own workspaces — the candidates come from the claims and each is re-checked with `can()` |
| `/api/dashboards` | POST | editor | Create; validates the spec and derives the workspace from trusted sources |
| `/api/dashboards/[id]` | GET | viewer | Current version with its spec |
| `/api/dashboards/[id]` | PUT | editor | Appends a **new immutable version** |
| `/api/dashboards/[id]` | DELETE | owner / source-admin | Soft delete |
| `/api/dashboards/[id]/export` | GET | viewer | Downloads the current spec as a JSON file (`Content-Disposition: attachment`). Carries source **ids** only — no workspace, author, or connection detail |
| `/api/dashboards/import` | POST | editor | Creates a dashboard at version 1 from an exported file. The target workspace is a request field re-checked by `can()`; source ids are re-pointed by an **explicit** mapping and any still unresolved refuse the whole import |
| `/api/dashboards/[id]/stream` | GET | viewer | SSE deltas, cookie-authenticated |
| `/api/dashboards/[id]/chat` | POST | viewer | Read-only chat with a guarded `runQuery` tool. Rate limited and budgeted |

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
| `/api/generate` | POST | editor | Streams a validated dashboard, panel, or explore-panel spec. Authorized against the workspace owning the selected **source**. Refuses with a 400 when that source's catalog was never refreshed or names nothing that still exists. Rate limited and budgeted |
| `/api/query` | POST | editor | One-shot guarded query for preview and Explore |
| `/api/sql/validate` | POST | editor | Runs the SQL guard against a source's catalog without executing. Always `200`; the verdict is `{ ok, error? }` |

## Sources

| Route | Method | Min role | Notes |
| --- | --- | --- | --- |
| `/api/sources` | GET | viewer | List sources in a workspace, each with its catalog health |
| `/api/sources` | POST | source-admin | Create |
| `/api/sources/generate` | POST | editor | Streams a validated `SourceDraft` — never credentials. Rate limited and budgeted |
| `/api/sources/[id]` | GET/PUT/DELETE | source-admin | Delete tombstones when referenced |
| `/api/sources/[id]/impact` | GET | source-admin | Dashboards and panels currently referencing the source, scoped to its workspace |
| `/api/sources/[id]/test` | POST | source-admin | Connectivity, latency, server and role identity, a **read-only proof**, and per-table reachability. All of it inside one rolled-back read-only transaction |
| `/api/sources/[id]/refresh` | POST | source-admin | Re-introspect the catalog; records freshness and any allowlisted table the database no longer has |

## Auth

| Route | Method | Notes |
| --- | --- | --- |
| `/api/auth/login` | GET | Begins the OIDC authorization-code flow |
| `/api/auth/callback` | GET | Verifies the token, mints the session cookie |
| `/api/auth/logout` | GET | Clears the session cookie |

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
