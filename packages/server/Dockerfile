FROM node:22-alpine AS builder
WORKDIR /app

# Copy ALL workspace package.json files so npm can resolve the workspace
# graph; the `packages/*` glob in the root manifest expects every workspace
# directory to have a package.json. Using `--workspace=open-think-server`
# narrows the actual install to the server's deps tree.
COPY package.json package-lock.json ./
COPY packages/cli/package.json ./packages/cli/
COPY packages/server/package.json ./packages/server/

RUN npm ci --workspace=open-think-server --include-workspace-root

COPY packages/server ./packages/server
RUN npm run build -w open-think-server

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/packages/server/package.json ./packages/server/
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/server/node_modules ./packages/server/node_modules

EXPOSE 3000
CMD ["node", "packages/server/dist/index.js"]
