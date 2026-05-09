FROM oven/bun:1-alpine AS builder
WORKDIR /app

# Single workspace post-AGT-030: the proxy server folded into the CLI, so
# the build context is just `packages/cli`. Copy manifests + lockfile first
# so bun can warm the install cache layer before we drop the source on top.
# Bun (AGT-060) replaces npm here for cross-platform optional-natives
# correctness and frozen-lockfile enforcement matching CI.
COPY package.json bun.lock ./
COPY packages/cli/package.json ./packages/cli/

RUN bun install --frozen-lockfile

COPY packages/cli ./packages/cli
RUN bun run --cwd packages/cli build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/package.json ./
COPY --from=builder /app/packages/cli/package.json ./packages/cli/
COPY --from=builder /app/packages/cli/dist ./packages/cli/dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/cli/node_modules ./packages/cli/node_modules

EXPOSE 4823
CMD ["node", "packages/cli/dist/index.js", "serve"]
