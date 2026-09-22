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
| `/api/dashboards` | GET | viewer | List dashboards in a workspace |
| `/api/dashboards` | POST | editor | Create; validates the spec and derives the workspace from trusted sources |
| `/api/dashboards/[id]` | GET | viewer | Current version with its spec |
| `/api/dashboards/[id]` | PUT | editor | Appends a **new immutable version** |
| `/api/dashboards/[id]` | DELETE | owner / source-admin | Soft delete |
| `/api/dashboards/[id]/stream` | GET | viewer | SSE deltas, cookie-authenticated |
| `/api/dashboards/[id]/chat` | POST | viewer | Read-only chat with a guarded `runQuery` tool. Rate limited and budgeted |

## Generation and query

| Route | Method | Min role | Notes |
| --- | --- | --- | --- |
| `/api/generate` | POST | editor | Streams a validated dashboard, panel, or explore-panel spec. Authorized against the workspace owning the selected **source**. Rate limited and budgeted |
| `/api/query` | POST | editor | One-shot guarded query for preview and Explore |

## Sources

| Route | Method | Min role | Notes |
| --- | --- | --- | --- |
| `/api/sources` | GET | viewer | List sources in a workspace |
| `/api/sources` | POST | source-admin | Create |
| `/api/sources/generate` | POST | editor | Streams a validated `SourceDraft` — never credentials. Rate limited and budgeted |
| `/api/sources/[id]` | GET/PUT/DELETE | source-admin | Delete tombstones when referenced |
| `/api/sources/[id]/test` | POST | source-admin | Connectivity test |
| `/api/sources/[id]/refresh` | POST | source-admin | Re-introspect the catalog |

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
| 409 | Source is tombstoned |
| 429 | A model-backed route hit the workspace's rate limit or token budget; the message says which and when it resets, and `Retry-After` is set. See [LLM rate limits and budgets](/operations/llm-limits/) |
| 500 | Infrastructure failure — deliberately opaque |
