# Security Policy

Holotable lets a language model author dashboard specifications — including SQL
— that the server then executes against a live database. That is a deliberately
sharp edge, so the trust model is written down here rather than left implied.

## Supported versions

Holotable is pre-1.0. There are no tagged releases or published images yet, so
there is nothing to back-port to: **only `main` is supported**, and security
fixes land as commits on `main`. This section will be replaced with a real
version support table once releases exist.

## Reporting a vulnerability

**Please do not open a public issue for a security report.**

Use GitHub's private vulnerability reporting:
[**Report a vulnerability**](https://github.com/jbouder/holotable/security/advisories/new).
The report stays private between you and the maintainers until a fix is
published, and it gives us a private fork to develop the fix in.

What to expect:

| Stage | Target |
| --- | --- |
| Acknowledgement that the report was received | 5 business days |
| Initial assessment — severity, whether we can reproduce it | 10 business days |
| Fix or documented mitigation for a confirmed high-severity issue | 90 days |

Holotable is maintained by one person. These are honest targets, not a
contractual SLA. If you have not heard back within the acknowledgement window,
please assume the notification was missed and ping the thread again.

A useful report includes the version or commit, how Holotable is deployed, what
you did, what happened, and what you expected instead. A proof of concept is
welcome but not required.

### Safe harbour

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
keywords and literals, and an allowlist check that every relation the tree
reads appears in the selected source's catalog. It is then wrapped by `buildExecutablePlan` as a
subquery, so the validated text cannot escape the wrapper.

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
and the page cannot be framed, so a rendering bug in model-authored text stops
at a console error. See
[Security headers](docs/src/content/docs/operations/security-headers.md).

### Trusted

**Keycloak group claims, after verification.** Tokens are verified RS256 against
the realm JWKS with issuer and audience checks. The validated `sub` and `groups`
claims are the *only* source of roles: `/workspaces/{id}/{viewer|editor|source-admin}`
and `/platform-admins`. Group parsing fails closed — a malformed group grants
nothing. `can()` in `src/lib/auth/authorize.ts` is the single decision point and
the only place the platform-admin bypass applies. OIDC is the only way to
authenticate; there is no local or development login path.

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
- **No published releases or signed artifacts.** There is nothing to verify the
  provenance of yet.

Reporting one of these as a new vulnerability is not necessary — they are known.
Reporting a *bypass* of a control described above very much is.
