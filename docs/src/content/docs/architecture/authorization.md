---
title: Authorization model
description: Group-based roles from Keycloak, one decision point, and the single sanctioned bypass.
sidebar:
  order: 2
---

Roles come **exclusively** from the token's `groups` claim (Keycloak group
paths):

```
/workspaces/{workspaceId}/viewer          # read dashboards
/workspaces/{workspaceId}/editor          # create/update/generate dashboards
/workspaces/{workspaceId}/source-admin    # manage sources; delete dashboards
/platform-admins                          # global admin (single sanctioned bypass)
```

## Rules

- **Highest role wins** within a workspace: `viewer < editor < source-admin`.
- **Authorization is never derived from a workspace id in a request body.** The
  workspace is taken from a trusted, already-scoped resource
  (`source.workspaceId`, `dashboard.workspaceId`) or, for list and create
  operations, checked against the identity for the requested workspace.
- **Unknown or malformed groups are ignored** — `parseGroups` fails closed and
  grants no role.

## Action matrix

| Action | Required |
| --- | --- |
| Dashboard list / get | viewer |
| Dashboard create / update / generate | editor |
| Dashboard delete | owner, source-admin, or platform-admin |
| Source CRUD / test / refresh | source-admin |
| Source use (list for a picker) | viewer |

## One decision point

`can(identity, action, ctx)` in `src/lib/auth/authorize.ts` is the only place
role decisions are made, and the only place the platform-admin bypass applies.
Every route calls `requireIdentity()` then `assertAuthorized(...)`; nothing
computes authorization inline.

The source is re-resolved and re-authorized on **every** execution, including
each poller tick — so revoking access to a source stops in-flight dashboards
from reading it, rather than waiting for a page reload.

## Sessions

A request is authenticated by a signed JWT in the session cookie. Two
verification strategies are selected by environment:

1. **Keycloak-issued tokens** (production): verified against the realm JWKS
   (RS256) with issuer and audience checks. Enabled when `OIDC_JWKS_URL` and
   `OIDC_ISSUER` are configured.
2. **Locally-signed session tokens** (HS256 via `SESSION_SECRET`): used by the
   OIDC callback to mint a first-party session, and by dev-only login.

Either way, only the validated `sub` and `groups` claims are ever trusted.

The session cookie is `httpOnly`, `Secure` in production, `SameSite=Lax`,
path `/`, with an 8-hour lifetime.

:::note
Dev login is hard-disabled in production and cannot bypass OIDC. Setup for the
Keycloak side is in [Keycloak setup](/operations/keycloak/).
:::
