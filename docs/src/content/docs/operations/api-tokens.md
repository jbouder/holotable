---
title: API tokens
description: Service-account tokens for pipelines and scripts that call the API, scoped to one workspace at viewer or editor.
---

People sign in with Keycloak. A deploy pipeline, a cron job or a script cannot
complete an OIDC sign-in, so it uses a **service-account API token**
([#288](https://github.com/jbouder/holotable/issues/288)) instead.

## Creating and revoking

A source-admin opens **Settings → API tokens**, names the token, and picks:

- **Role:** `viewer` or `editor` in that workspace. Never `source-admin`, never
  platform admin, and never another workspace.
- **Expires after:** up to `API_TOKEN_MAX_DAYS` days (default 90). Every token
  expires.

The token (`ht_…`) is shown **once**; only its SHA-256 is stored. The list shows
when each token was last used, so one that nothing uses stands out. **Revoke**
refuses it from the next request on. Creating and revoking are audited
(`token.create`, `token.revoke`), and every request a token makes is audited
with the token as the actor (`token:<id>`).

The API behind the page needs `source:manage` in the workspace, which no token
can hold:

| Route | Method | Notes |
| --- | --- | --- |
| `/api/workspaces/[id]/tokens` | GET | The workspace's tokens, without the tokens themselves |
| `/api/workspaces/[id]/tokens` | POST | `{ name, role: "viewer" \| "editor", expiresInDays }`; the token is in this response only |
| `/api/workspaces/[id]/tokens/[tokenId]` | DELETE | Revoke |

## Using one

Send it as a bearer token. Posting a deploy marker from CI
([annotations](/concepts/annotations/)) with an editor token:

```sh
curl -fsS -X POST "$HOLOTABLE_URL/api/workspaces/ops/annotations" \
  -H "Authorization: Bearer $HOLOTABLE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"kind\":\"deploy\",\"title\":\"api $GIT_SHA\",\"source\":\"github-actions\"}"
```

## What a token can and cannot do

- **Exactly its role in its workspace.** The token resolves to an identity with
  one workspace role, and `can()` decides each request exactly as it would for a
  person with that role. A viewer token reads; an editor token also writes
  dashboards and annotations.
- **Not a session.** A bearer header that is not a valid token is refused, never
  passed over in favor of a cookie. A token cannot open a dashboard stream, and
  cannot create or revoke tokens.
- **Also an MCP credential.** `/api/mcp` accepts one in the same header, by its
  prefix, resolving exactly as above; see
  [MCP clients](/operations/keycloak/#5-mcp-clients).
- **Not from a browser page.** A mutation that carries an `Origin` from another
  site is refused before authentication, token or not. A token is for a server
  calling the API, not for JavaScript on a web page.
- **Row-filtered sources.** A token carries no realm claims, so a
  [row-filtered source](/operations/row-level-filters/) refuses a query made with
  it, rather than returning every row.

Treat a token as a password: keep it in the pipeline's secret store, give it the
lowest role that works and a short expiry, and revoke it when it is no longer
needed.

---

*Last verified against the code at commit `00ea858` (2026-10-05).*
