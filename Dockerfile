# syntax=docker/dockerfile:1
#
# Sideout production image (docs/deploy.md, "Railway"). Two stages: the build
# stage has the C++ toolchain better-sqlite3 needs when no prebuilt binary
# matches, installs every dependency and runs `next build`; the runtime stage
# is Node 22 with production dependencies only, the built app, and the pieces
# the start command's migrate and seed CLIs read (`src/`, `drizzle/`,
# `tsconfig.json`), running as the unprivileged `node` user.
#
# Build arguments Railway passes through from service variables (a declared
# ARG receives the variable of the same name):
#   LUCRA_MODE  baked into the browser bundle as NEXT_PUBLIC_LUCRA_MODE; the
#               runtime LUCRA_MODE must match or src/env.ts refuses to boot.
#   BUILD_SHA   the deployed commit, reported by /health and used as the
#               service worker's cache version. `railway up` uploads a
#               tarball without `.git`, so set it explicitly (docs/deploy.md).
#   DEMO_ACCOUNTS  the public demo's account picker (docs/deploy.md, "Public
#               demo"): baked into the browser bundle as
#               NEXT_PUBLIC_DEMO_ACCOUNTS; the runtime DEMO_ACCOUNTS must match
#               or src/env.ts refuses to boot. Off unless the variable says true.

FROM node:22-bookworm-slim AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# Full install (dev dependencies included): the build needs them, and
# NODE_ENV is set only afterwards so npm does not omit them here.
RUN npm ci
COPY . .
ARG LUCRA_MODE=mock
ARG BUILD_SHA
ARG DEMO_ACCOUNTS=false
ENV NODE_ENV=production \
    LUCRA_MODE=${LUCRA_MODE} \
    DEMO_ACCOUNTS=${DEMO_ACCOUNTS} \
    NEXT_TELEMETRY_DISABLED=1
# NODE_ENV=production at build time keeps `route.dev.ts` out of the build
# (src/lib/build-gates.ts); `.next/cache` is build-only; the prune leaves
# production dependencies plus `tsx`, which the start command's CLIs run on.
RUN BUILD_SHA="${BUILD_SHA:-unknown}" npm run build \
  && rm -rf .next/cache \
  && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    DATABASE_PATH=/data/sideout.db
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json /app/next.config.ts /app/tsconfig.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/drizzle ./drizzle
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# The persistent volume mounts at /data (railway.json). The entrypoint starts
# as root, makes that directory writable by `node`, and runs the command as
# `node`: a volume arrives owned by root, so a `USER` switch at build time
# could not open the database file on it.
RUN mkdir -p /data && chown node:node /data
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
# Seed the demo dataset once (only when no database file exists yet), then
# apply migrations on every start, then serve. railway.json repeats this as
# the service start command. The seed runs before the migrate on purpose:
# `npm run db:migrate` creates an empty file, which would make the existence
# test skip the seed forever.
CMD ["sh", "-c", "(test -f \"$DATABASE_PATH\" || npm run seed) && npm run db:migrate && npm run start"]
