---
title: Keycloak setup
description: Configure the OIDC client and the group-membership mapper Holotable needs.
sidebar:
  order: 1
---

Holotable derives all authorization from the `groups` claim of the session
token. Keycloak does **not** include group memberships in tokens by default —
you must add a group-membership mapper.

## 1. Realm, client, groups

1. Create (or reuse) a realm, e.g. `holotable`.
2. Create an OpenID Connect client:
   - Client ID: `holotable`
   - Client authentication: **On** (confidential) → copy the client secret.
   - Valid redirect URIs: `http://localhost:3000/api/auth/callback`
     (add your production origin too).
   - Standard flow: enabled.
3. Create the groups that encode roles. Group **paths** must match exactly:

   ```
   /workspaces/{workspaceId}/viewer
   /workspaces/{workspaceId}/editor
   /workspaces/{workspaceId}/source-admin
   /platform-admins
   ```

   For a workspace `acme`: create a top-level group `workspaces`, a child
   `acme`, and children `viewer` / `editor` / `source-admin`. Create a separate
   top-level group `platform-admins` for global admins, then assign users.

## 2. Add the group-membership mapper

The mapper puts full group paths into a `groups` claim.

1. Client → **Client scopes** → `holotable-dedicated` → **Add mapper** →
   *By configuration* → **Group Membership**.
2. Configure:
   - Name: `groups`
   - Token Claim Name: `groups`
   - **Full group path: On** — produces `/workspaces/acme/editor`, which is what
     Holotable parses.
   - Add to ID token: On
   - Add to access token: On
   - Add to userinfo: On
3. Save.

:::danger[Full group path must be On]
With *Full group path: Off*, only the leaf name (`editor`) is emitted and
Holotable cannot map it to a workspace. The user ends up with no roles at all,
because `parseGroups` fails closed.
:::

## 3. Point Holotable at the realm

Set these in `.env` (see `.env.example`):

```bash
OIDC_ISSUER=http://localhost:8080/realms/holotable
OIDC_CLIENT_ID=holotable
OIDC_CLIENT_SECRET=<client secret>
OIDC_JWKS_URL=http://localhost:8080/realms/holotable/protocol/openid-connect/certs
OIDC_GROUPS_CLAIM=groups
OIDC_SCOPE=openid profile groups
```

- `OIDC_JWKS_URL` enables RS256 verification of Keycloak-issued tokens.
- The login flow lives at `/api/auth/login` → Keycloak → `/api/auth/callback`,
  which verifies the token and mints a first-party session cookie.

## 4. Verify the claim

Decode an issued token and confirm it contains:

```json
{
  "sub": "…",
  "groups": ["/workspaces/acme/editor", "/platform-admins"]
}
```

If `groups` is missing or contains bare names rather than paths, revisit step 2.
How those paths become roles is described in
[Authorization model](/architecture/authorization/).
