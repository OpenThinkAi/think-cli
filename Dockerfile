FROM node:22-alpine AS builder
WORKDIR /app

# Single workspace post-AGT-030: the proxy server folded into the CLI, so
# the build context is just `packages/cli`. Copy manifests first so npm can
# warm the lockfile cache layer before we drop the source on top.
COPY package.json package-lock.json ./
COPY packages/cli/package.json ./packages/cli/

RUN npm ci --workspace=open-think --include-workspace-root

COPY packages/cli ./packages/cli
RUN npm run build -w open-think

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/packages/cli/package.json ./packages/cli/
COPY --from=builder /app/packages/cli/dist ./packages/cli/dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/cli/node_modules ./packages/cli/node_modules

EXPOSE 4823
CMD ["node", "packages/cli/dist/index.js", "serve"]
