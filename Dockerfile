# AGT-064: container hardening bundle. Both stages digest-pinned (sha256:...)
# rather than tag-pinned (e.g. `:1-alpine` or `:22-alpine`). Tag-pinning
# accepts whatever the registry currently points the tag at; digest-pinning
# binds to an exact image content hash, so a compromised or rotated upstream
# tag can't ship a malicious base layer into our image. Renovate /
# Dependabot's docker ecosystem keeps these moving.

# Builder uses bun (AGT-060) for install + build. Bun handles cross-platform
# optional native bindings without the npm/cli#4828 lockfile-baking bug.
FROM oven/bun:1-alpine@sha256:4de475389889577f346c636f956b42a5c31501b654664e9ae5726f94d7bb5349 AS builder
WORKDIR /app

# alpine doesn't ship perl; the cli's `build` script post-processes the
# tsup output with `perl -i -pe 's/from "sqlite"/from "node:sqlite"/g'`
# (chosen for BSD/GNU portability across dev + CI). Install it here so
# the builder can run the script unchanged.
RUN apk add --no-cache perl

# Copy manifests + lockfile first so bun can warm the install cache layer
# before we drop the source on top. Single workspace post-AGT-030.
COPY package.json bun.lock ./
COPY packages/cli/package.json ./packages/cli/

RUN bun install --frozen-lockfile

COPY packages/cli ./packages/cli
RUN bun run --cwd packages/cli build

# Deps stage: production-only install (no tsup, vitest, esbuild, rolldown,
# tsx, typescript, lightningcss, etc.) — AGT-064 AC #2. The builder needs
# devDeps for tsup; the runtime only needs to run the bundled output, so we
# do a fresh install with --production rather than copying the builder's
# fat node_modules. It runs in its own bun stage (same alpine/musl base as
# the runtime, so native bindings match) and only node_modules is copied
# forward: the bun binary never lands in the runtime image (AGT-2341).
FROM oven/bun:1-alpine@sha256:4de475389889577f346c636f956b42a5c31501b654664e9ae5726f94d7bb5349 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/cli/package.json ./packages/cli/
RUN bun install --frozen-lockfile --production

# Runtime stage: node + production node_modules + the built dist only.
FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/package.json ./
COPY --from=deps /app/packages/cli/package.json ./packages/cli/
COPY --from=deps /app/node_modules ./node_modules

COPY --from=builder /app/packages/cli/dist ./packages/cli/dist

# AGT-064 AC #3: drop to UID 1000 before CMD. node:22-alpine ships with a
# `node` user (uid 1000, gid 1000) baked in, so we just chown /app to it
# and switch. The container can't escalate after this point.
#
# /data is the persistence mount in docker-compose.yml. Docker materializes
# named volumes as `root:root` when the path doesn't pre-exist in the
# image, so we mkdir + chown it here too — without this, the first
# `docker compose up` would crash with EACCES the moment `think serve`
# tried to write the SQLite DB.
#
# UPGRADE NOTE for existing deployments: pre-AGT-064 images ran as root
# and populated /data with root-owned files. After upgrading, running as
# UID 1000 will hit EACCES on those pre-existing files. Migrate once with:
#   docker compose run --rm --user root server chown -R 1000:1000 /data
RUN mkdir -p /data && chown -R node:node /app /data
USER node

EXPOSE 4823

# AGT-064 AC #4: HEALTHCHECK against the unauthenticated /v1/health probe
# (auth is intentionally bypassed for the health route per docs/serve.md).
# busybox wget ships in node:22-alpine; --spider issues a GET that discards
# the body, which suits a liveness probe and matches the load-balancer
# usage pattern the route was designed for. If /v1/health ever moves
# behind auth, this command goes unhealthy and `restart: unless-stopped`
# loops the container — the route's unauth status is load-bearing here.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:4823/v1/health || exit 1

CMD ["node", "packages/cli/dist/index.js", "serve"]
