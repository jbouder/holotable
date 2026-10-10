# Security Policy

Holotable lets a language model author dashboard specifications — including SQL
— that the server then executes against a live database. That is a deliberately
sharp edge, so the trust model is written down here rather than left implied.

## Supported versions

Holotable is pre-1.0. Images are published from `main` (`ghcr.io/jbouder/holotable:main`
and `:quickstart`), but there are no tagged releases yet, so there is nothing
to back-port to: **only `main` is supported**, and security fixes land as
commits on `main` and in the next published image. This section will be
replaced with a real version support table once releases exist.

## Reporting a vulnerability

**Please do not open a public issue for a security report.**

Use GitHub's private vulnerability reporting:
[**Report a vulnerability**](https://github.com/jbouder/holotable/security/advisories/new).
The report stays private between you and the maintainers until a fix is
published, and it gives us a private fork to develop the fix in.

What to expect:

| Stage | Target |
| --- | --- |
| Acknowledgment that the report was received | 5 business days |
| Initial assessment — severity, whether we can reproduce it | 10 business days |
| Fix or documented mitigation for a confirmed high-severity issue | 90 days |

Holotable is maintained by one person. These are honest targets, not a
contractual SLA. If you have not heard back within the acknowledgment window,
please assume the notification was missed and ping the thread again.

A useful report includes the version or commit, how Holotable is deployed, what
you did, what happened, and what you expected instead. A proof of concept is
welcome but not required.

### Safe harbor

We will not pursue or support legal action against anyone who makes a good
faith effort to comply with this policy. Good faith means: report promptly,
give us reasonable time to fix the issue before disclosing it publicly, only
test against infrastructure you own or have permission to test, and avoid
privacy violations, data destruction, and degradation of anyone's service. If a
third party brings legal action against you for research conducted in good
faith under this policy, we will make it known that your actions were
authorized.

## Trust boundaries

The enforcement points behind each of these are the numbered guarantees in
[Invariants](docs/src/content/docs/architecture/invariants.md). This section
says what is trusted and what is not; that document says where it is enforced.

### Not trusted

**Model output — specifications and SQL alike.** The model produces a spec, never
data. Generated specs are re-parsed against the shared Zod IR (`src/lib/ir.ts`)
before anything reads them. Generated SQL goes through `validateSql`
(`src/lib/sql/safety.ts`): it is parsed with the real PostgreSQL grammar
(`src/lib/sql/ast.ts`) and must be exactly one `SELECT` built only from
allowlisted constructs — no other statement type anywhere in the tree, no
`SELECT INTO`, no row locking, no comments — with a function denylist applied
to every call in the tree, a ban on time and non-deterministic functions,
keywords and literals, an allowlist check that every relation the tree
reads appears in the selected source's catalog, and a column check that no
column the catalog marks unexposed is read — by name, by `*`, by the table's
whole row, or through a column alias list or `NATURAL JOIN`. It is then
wrapped by `buildExecutablePlan` as a subquery, so the validated text cannot
escape the wrapper.

Generated PromQL, for a Prometheus source, goes through `validatePromql`
(`src/lib/promql/safety.ts`): parsed with the Prometheus project's own grammar,
it must be one expression of allowlisted node types in which every selector
names exactly one metric on the source's allowlist. The `@` modifier and
comments are refused, and ranges and offsets are bounded. A variable value and
the viewer's tenant matcher are written in only as escaped label-matcher
literals, and each rewrite is re-parsed and compared with the original tree.

**User prompts.** A prompt reaches the model, and the model's output is
untrusted regardless of what the prompt asked for. Every guard above applies
identically whether the SQL was suggested by a prompt or invented by the model.
A prompt cannot widen the catalog allowlist, change the time window, or raise a
row limit, because none of those are model-controlled.

**Catalog metadata from a connected database.** Refreshing a source introspects
the live schema through `information_schema.columns`, and the resulting table
and column names are sent to the model as prompt context. Names in someone
else's database are attacker-influenced text entering a prompt. Only names and
types are sent — never sample rows (invariant 9). Each value is flattened to
one line, stripped of control characters and clamped to its schema maximum,
and the catalog is fenced between markers that carry a random per-call token
(`src/lib/ai/untrusted.ts`), so a name cannot break out of the data block; the
stored panel specs in the dashboard chat prompt get the same treatment. The
model's output is untrusted anyway, which is what ultimately contains this.

**Chat conversations.** Chat keeps a person's conversations on the server:
what they asked, the answers, and the panel specs drawn in them. Each one is
readable only by the person who had it, with no route for anyone else to read
it, a platform admin included. A stored message never holds a result row,
only a panel's spec and a five-row sample of what it returned. Nothing stored
is authorization: the sources are re-checked on every turn and every re-run,
and a stored spec passes the guard again, against the catalog as it is then.
**Keep my conversations** off stores none and deletes what was kept.

**A Prometheus endpoint, and the URL that names it.** A source admin types a
Prometheus source's URL, and the server then sends it queries, with the
source's credential when it has one. The URL is held to the rules a model base
URL is: `https` only, public addresses only (checked on every address the name
resolves to and again on each connection), no credentials in it, and no
redirects followed. The one exception is the operator's `SOURCE_URL_ALLOWLIST`,
a list of hosts and ranges a source URL may reach although they are not public,
which is the control for an in-cluster Prometheus. It is one list for every
workspace, so an endpoint that must stay one tenant's should require auth
behind a `secret_ref` only that workspace is granted. What the endpoint answers
is untrusted too: metric names, help text and labels from discovery are
catalog metadata (above), a result is capped in series, points and bytes, and a
native histogram is refused rather than drawn.

**Workspace prompt customization.** A source-admin can add a glossary, metric
definitions and example panels to every generation in their workspace (#66).
It is written by someone the workspace trusts, but it is still text entering a
prompt, and it gets the catalog's treatment: flattened, clamped, length-capped
and fenced, with the rules after it. An example panel cannot be saved unless
its SQL passes the guard against a live source in the same workspace, and an
example is left out of a generation once it no longer passes against the
current catalog. Nothing in it is enforced by the prompt alone: the guard and
the IR apply to the output exactly as before.

**The browser, and every request payload.** The client is a rendering surface,
not an authority. The server resolves the concrete time range from the relative
expression, injects `from`/`to` as **bound parameters** on the declared
`timeField`, applies the row cap, result-byte cap, and statement timeout, and
runs every query inside a `READ ONLY` transaction with `search_path` pinned to
the source's configured schema. Authorization is never derived from a workspace
id in a request body — it comes from the identity, and the source is re-resolved
and re-authorized on **every** execution, including each poller tick. Every page
carries a nonce-based `Content-Security-Policy` (`src/proxy.ts`): no inline
script runs without the request's nonce, nothing loads from another origin,
and the page cannot be framed (a share link's `/embed/` page only by the
origins its token names), so a rendering bug in model-authored text stops at a
console error. See
[Security headers](docs/src/content/docs/operations/security-headers.md).

### Trusted

**Keycloak group claims, after verification.** Tokens are verified RS256 against
the realm JWKS with issuer and audience checks. The validated `sub` and `groups`
claims are the *only* source of roles: `/workspaces/{id}/{viewer|editor|source-admin}`
and `/platform-admins`. Group parsing fails closed — a malformed group grants
nothing. `can()` in `src/lib/auth/authorize.ts` is the single decision point and
the only place the platform-admin bypass applies. A sign-in is bound to the
browser that started it: the callback requires the `state` it set, redeems the
code with a PKCE (S256) verifier only that browser holds, and refuses an
id_token whose `nonce` is not the one it sent, so an authorization code taken
from someone else's sign-in cannot be used to become them. OIDC is the only way to
authenticate a real user; there is no local or development login path.

**Sessions, and their renewal.** A session is a first-party HS256 token signed
with `SESSION_SECRET`, minted only from a verified realm id_token. When the
realm issues a refresh token, the session token is short-lived (half the
refresh token's idle lifetime, at most 8 hours) and `POST /api/auth/refresh`
renews it by asking the realm again and re-deriving the groups from the fresh
id_token, so a removed group stops working within one token lifetime. The
refresh token never reaches the browser: it is stored in `sessions` sealed with
AES-256-GCM under a key derived from `SESSION_SECRET`, and the browser holds
only a random id for it, in an `httpOnly` cookie scoped to `/api/auth`, whose
SHA-256 is what the table stores. Sign-out deletes the row; a refused renewal
deletes it too.

**Model keys entered in the app.** A workspace's or a person's model API key
(#331) is sealed the same way, AES-256-GCM under a key derived from
`SESSION_SECRET` with its own HKDF label, and is write-only: no route returns
it, a settings page shows at most its last four characters, and every key is
registered with the log's redaction when it is opened or saved, so it cannot
reach a log line, the generation log or an audit row. A stored key is kept
only while the base URL stays on the same origin. Rotating `SESSION_SECRET`
makes every stored key unreadable, which surfaces as "enter the key again".
The base URL itself is untrusted: it must be `https` and resolve only to
public addresses, checked again on every connection (so DNS rebinding does
not get around it), unless the operator allowlists the host or range in
`AI_BASE_URL_ALLOWLIST`; redirects are not followed.

**Read-only share links.** A share link (#65) is the one credential that is
not a session. Its `hts_` token is signed with a key derived from
`SESSION_SECRET`, and only its SHA-256 is stored. Every use checks the token
against its row: not revoked, not expired, the very token minted, for that
dashboard. It resolves to an identity that `can()` allows `dashboard:view` on
that one dashboard and nothing else, ahead of every other rule. Only the
dashboard's stream and the `/embed/` page accept it. The page is sent no SQL or
source ids, may be framed only by the origins the token names, and the link is
revocable at once. See
[Share links](docs/src/content/docs/integrations/share-links.md).

**Service-account API tokens.** A pipeline or script calls the API with
`Authorization: Bearer ht_…` (#288). A source-admin mints the token in one
workspace at viewer or editor, never source-admin or platform admin; a CHECK in
`api_tokens` holds the role, and the resolver refuses any other. Only the
token's SHA-256 is stored, and the plaintext is shown once. Every request looks
the row up again, so revocation and expiry (at most `API_TOKEN_MAX_DAYS`) take
effect on the next one. `can()` decides from the token's single role, with no
rule of its own. A bearer header that is not a valid token is a refusal, never
a fall back to the cookie. Tokens cannot open a dashboard stream or manage
tokens. A browser page on another origin cannot use one for a mutation,
because the origin check refuses it before authentication. Requests made with
a token are audited as `token:<id>`. See
[API tokens](docs/src/content/docs/integrations/api-tokens.md).

**MCP clients.** An MCP client (#149) reaches `/api/mcp`, and only that
route, with an access token the realm minted for a second, public realm
client (`OIDC_MCP_CLIENT_ID`), obtained by the client itself through the
authorization-code flow with PKCE after a `401` that names the server's
protected-resource metadata (RFC 9728). Holotable mints nothing for it. The
token is verified on every request against the realm's keys, issuer, expiry,
audience *and* `azp` (minted for the MCP client, not merely addressed to it),
must be an access token rather than an id_token, and is refused once its
realm session is revoked, so a back-channel logout ends an MCP session too.
Its identity is the token's `groups` through the same parser, and `can()`
decides every call as for a session. No other route reads a realm token:
`getIdentity()` knows only the session cookie and `ht_` tokens, a token
minted for the MCP client is refused as a session by `azp`, and the MCP route
reads no cookie. A service-account token is accepted there as well, by its
prefix, with the same resolution as elsewhere. The tools behind the route
(#148) are façades over the functions the HTTP routes call: each applies the
same `can()` check as its route, re-authorizes the source on every execution,
runs SQL through the same guard, plan and read-only executor with the same
limits, and records the same audit event; none returns a connection detail,
a credential or an unguarded row, and the model's answers are specs the IR
validated, never data. See
[Keycloak setup](docs/src/content/docs/admin/keycloak.md) and the
[MCP server](docs/src/content/docs/integrations/mcp.md).

**Cookies and cross-origin requests.** The session cookie is `httpOnly` and
`SameSite=Lax`. When it is `Secure`, its name is `__Host-` prefixed, so the
browser accepts it only from this host with `Path=/` and no `Domain`; a sibling
subdomain cannot plant or overwrite it. Independently of `SameSite`, every
state-changing request is refused with a 403 before any handler runs unless it
came from this app's own origin (by `Sec-Fetch-Site`, or `Origin` where the
browser sends no Fetch Metadata) or from one listed in `ALLOWED_ORIGINS`. A
request with neither header did not come from a page and is left to
authentication. See
[Authorization](docs/src/content/docs/architecture/authorization.md#requests-from-other-origins).

**Back-channel logout.** When the realm ends a session it POSTs a signed
logout token to `/api/auth/backchannel-logout`. The token's signature (realm
JWKS only), issuer, audience (this client), age (five minutes) and `events`
claim are all checked, and one carrying a `nonce` is refused, so an id_token
from the same realm cannot pass for one. A valid one revokes the realm session
it names at once: its session tokens stop verifying on the next request, its
open dashboard streams are closed, and its stored refresh token is deleted.
The revocation list is in memory (one instance by design), so a restart
forgets it; a revoked token then works until it expires, at most one session
token lifetime, and cannot be renewed.

**Open streams.** A dashboard stream is authorized when it connects and
then held to the session it connected with: it is closed at that session
token's expiry, on revocation, and when a re-check every
`SSE_REAUTH_INTERVAL_MS` (60s) finds the dashboard deleted or outside the
viewer's workspaces. A browser reconnects with its renewed session, which is
authorized afresh, so a group removed in the realm stops a stream within one
session-token lifetime.

**Row-level filters.** A source can carry a `rowFilter` naming a column and a
session claim. Every table a statement on that source reads is then narrowed to
the viewer's rows before the statement sees them. The predicate is not applied
to the output, which a statement can relabel as any tenant. The value is a
bound parameter from the verified identity. The rewrite re-parses its own output
and refuses anything it cannot prove is fully narrowed, and a viewer without
the claim is refused, platform admins included. See
[Row-level filters](docs/src/content/docs/admin/row-level-filters.md).

**The audit log.** Sign-ins, sign-outs, every change to a dashboard, source,
template or workspace limit, every statement a person runs, and every request
`assertAuthorized` refuses are written to `audit_log`. The actor is the
verified identity and the workspace is the one the action was authorized in.
`detail` passes through the log's redaction, so SQL and prompts are kept as a
digest, and keys shaped like query results are dropped. Triggers refuse
`UPDATE`, `DELETE` and `TRUNCATE` for every role, including the table's owner.
That stops anything able to issue only DML, but not an owner deliberately
running DDL. Read through `GET /api/audit`: a workspace source-admin sees their
own workspaces, and a platform admin sees everything. See
[Audit log](docs/src/content/docs/operations/audit-log.md).

**Demo mode is outside this trust model.** `AUTH_MODE=demo` hands every
visitor a session with no login, so anyone who can reach the server is a
member of the `DEMO_GROUPS` workspaces. The server refuses to boot it beside
any OIDC configuration or with groups that reach `source-admin` or
`/platform-admins`, so a visitor can never register a source. That fences it;
it does not make it safe for real data. Never run demo mode on an instance that
holds a real source, a real credential, or anything you would not publish. A
report that demo mode lets a visitor do what its documented editor role
allows is not a vulnerability; one that lets a visitor exceed that role, or
reach a demo session from an `oidc` deployment, is.

**The server environment.** Database credentials live only in environment
variables (or files in `SOURCE_SECRETS_DIR`) and are resolved at execution
through a `secret_ref` name — `TS_METRICS` resolves `TS_METRICS_USERNAME` /
`TS_METRICS_PASSWORD`. A `secret_ref` is a name, not a secret, and it resolves
only for a workspace `SOURCE_SECRET_REFS` grants it to: an unset declaration
grants nothing, and the grant is checked on every connection, so a
`source-admin` in one workspace cannot borrow another workspace's database role
by naming its ref. Credentials are never written into a dashboard spec, a panel
config, a database row, or any client payload, and the resolved role is expected
to be read-only in the database itself.

## Known limitations

These are real and currently unmitigated. They are listed because a reader
deciding whether to run Holotable deserves to know them up front.

- **The function denylist is still a denylist.** Statement shape and table
  access are decided from the parse tree, but which *functions* a query may
  call is decided by name against a list. A function this project has not
  heard of — including any function an operator defines in the metrics schema
  — can be called. The execution-side defenses — read-only transaction, bound
  parameters, pinned `search_path`, row and result-byte caps, statement timeout,
  and a read-only database role — are what contain a call the list misses.

  Note what the read-only role does and does not bound: it is granted `SELECT`
  on *all* tables in the metrics schema, not only the tables in a source's
  catalog. The role stops writes and reaches outside the schema; it is the
  catalog allowlist, and nothing else, that confines a query to the tables a
  source declares. A construct that evades the allowlist — a function taking a
  query string, for instance — therefore reaches real data within that schema.
  `test/sql-safety-postgres.test.ts` pins the ones that are known and blocked,
  and `test/sql-safety.fuzz.test.ts` searches for ones that are not, from a
  fixed seed on every test run and from a fresh seed in CI.
- **The LLM rate limiter is per instance.** The per-user token bucket lives in
  process memory, so N replicas allow N times `LLM_RATE_PER_MINUTE`. The
  per-workspace daily token budget is in Postgres and is shared, and it gates
  admission rather than metering the stream: a day can overshoot by the calls
  already in flight when it fills.
- **The poller is single-instance.** Running more than one replica means more
  than one poller per dashboard, multiplying query load against the metrics
  store. Holotable does not yet coordinate pollers across instances.
- **No signed artifacts.** The images published from `main` are not signed
  and carry no provenance attestation or SBOM; there are no tagged releases.

Reporting one of these as a new vulnerability is not necessary — they are known.
Reporting a *bypass* of a control described above very much is.
