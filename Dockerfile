# Holotable images.
#
# Two publishable targets share the `deps` and `build` stages:
#
#   runtime  (default) the Next.js standalone server. Nothing but the traced
#            server bundle, its static assets, and `public/`.
#   migrate  the one-shot job image for `scripts/migrate.ts` and
#            `scripts/seed.ts`; carries `tsx` and the dependencies it needs.
#
# The base is pinned by digest so every stage builds from the same bytes on
# every machine; Renovate keeps the digest current (#37). Every other stage
# derives from `base`, so this is the only line that names an external image.
FROM node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# The unprivileged user both publishable targets run as.
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

# ---- deps ----
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# ---- build ----
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- migrate ----
# One-shot job image: `docker compose` runs `migrate` and `seed` from it.
# The scripts are TypeScript run through `tsx`, a devDependency, so this
# stage takes the full lockfile-resolved `node_modules` from `deps` rather
# than a `--omit=dev` install plus an unlocked `tsx`. It is a job image that
# exits; its size does not matter the way the long-running `runtime` does.
FROM base AS migrate
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./package.json
COPY migrations ./migrations
COPY scripts ./scripts

USER nextjs
CMD ["node", "node_modules/.bin/tsx", "scripts/migrate.ts"]

# ---- runtime ----
FROM base AS runtime
ENV NODE_ENV=production

# `next build` with `output: "standalone"` traces the server's runtime
# dependencies (including the externalized `pg` and `libpg-query`, WebAssembly
# binary included) into .next/standalone/node_modules. That is the whole
# dependency tree this image needs; the full `node_modules`, `scripts/`, and
# `migrations/` belong to the `migrate` target.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
# `public/` is empty today — the favicon is an App Router route file at
# src/app/favicon.ico — and git does not track empty directories, so it is held
# open by public/.gitkeep. Do not delete that file: without it this COPY fails
# the image build on a fresh checkout while `next build` still succeeds, so the
# breakage only shows up here.
COPY --from=build /app/public ./public

USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
# Liveness only: /api/health answers whenever the process is serving, with no
# I/O. The slim base has no curl or wget, so the probe is Node's own fetch.
# Readiness (database, Keycloak) is a separate endpoint (#53).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server.js"]
