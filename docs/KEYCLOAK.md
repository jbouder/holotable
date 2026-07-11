# Keycloak setup (OIDC + group claim)

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

   Example: for a workspace `acme`, create a top-level group `workspaces`, a
   child `acme`, and children `viewer` / `editor` / `source-admin`. Create a
   separate top-level group `platform-admins` for global admins. Assign users to
   the appropriate groups.

## 2. Add the group-membership mapper

The mapper puts full group paths into a `groups` claim.

1. Client → **Client scopes** → `holotable-dedicated` → **Add mapper** → *By
   configuration* → **Group Membership**.
2. Configure:
   - Name: `groups`
   - Token Claim Name: `groups`
   - **Full group path: On** (produces `/workspaces/acme/editor`, which is what
     Holotable parses).
   - Add to ID token: On
   - Add to access token: On
   - Add to userinfo: On
3. Save.

> If you set *Full group path: Off*, only the leaf name (`editor`) is emitted
> and Holotable cannot map it to a workspace. Keep it **On**.

## 3. Point Holotable at the realm

Set these in `.env` (see `.env.example`):

```
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

Decode an issued token (e.g. at jwt.io or via the account console) and confirm
it contains:

```json
{
  "sub": "…",
  "groups": ["/workspaces/acme/editor", "/platform-admins"]
}
```

## Development without Keycloak

When `DEV_AUTH_ENABLED=true` (default outside production), `POST /api/auth/dev-login`
mints a signed session for an arbitrary `sub` + `groups`, so you can exercise
every role locally. This route is hard-disabled when `NODE_ENV=production` or
`DEV_AUTH_ENABLED` is false, so it can never bypass OIDC in a real deployment.

```bash
curl -c cookies.txt -X POST http://localhost:3000/api/auth/dev-login \
  -H 'content-type: application/json' \
  -d '{"sub":"dev","groups":["/workspaces/demo/source-admin","/platform-admins"]}'
```
