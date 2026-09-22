#!/usr/bin/env bash
#
# Runs once inside the dev container, after it is created.
#
# Dependencies, the schema, and then an honest account of what is still
# missing. The last part matters more than it looks: every other step here can
# succeed and the app will still refuse to generate anything without a model,
# and a contributor who is not told that meets it as a 500 on their first
# prompt.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "==> npm ci"
npm ci

# Idempotent and advisory-locked, so this is safe alongside the `migrate`
# compose service that has already run. It is here because it also proves the
# contributor's own toolchain reaches the database, which is the failure worth
# catching now rather than on their first `npm run seed`.
echo "==> npm run migrate"
npm run migrate

echo "==> npm run config:check"
# Never fatal: it reports what would not boot, and a half-configured .env on a
# fresh checkout is the expected state, not a broken container.
npm run config:check || true

# Read from .env rather than the environment: the values that are still missing
# are the ones a contributor has to write into that file.
env_value() {
  sed -n "s/^$1=//p" .env | tail -n 1
}

missing=()
[ -n "$(env_value AI_MODEL)" ] || missing+=("AI_MODEL")
if [ -z "$(env_value OPENAI_API_KEY)" ] && [ -z "$(env_value AI_GATEWAY_API_KEY)" ]; then
  missing+=("OPENAI_API_KEY (or AI_GATEWAY_API_KEY)")
fi

cat <<'BANNER'

────────────────────────────────────────────────────────────────────────
 Holotable dev container is ready.

   npm run dev        http://localhost:3000
   npm test           node --test
   npm run lint       biome check

 TimescaleDB and Keycloak are already running as sibling services, and
 the seeder is inserting demo metrics into the `demo` workspace.
BANNER

if [ ${#missing[@]} -gt 0 ]; then
  echo
  echo " Still to set in .env before anything can be generated:"
  for name in "${missing[@]}"; do
    echo "   - $name"
  done
  cat <<'BANNER'

 The model is the one thing this container cannot supply. See the
 "AI provider" section of .env.example, or:
 docs/src/content/docs/operations/ai-provider.md
BANNER
fi

cat <<'BANNER'

 Sign-in is Keycloak-only — there is no dev login. The realm at
 http://localhost:8080 is imported from keycloak/; the group mapper it
 needs is in docs/src/content/docs/operations/keycloak.md.
────────────────────────────────────────────────────────────────────────

BANNER
