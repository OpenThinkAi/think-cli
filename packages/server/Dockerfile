FROM node:22-alpine AS builder
WORKDIR /app

# Copy workspace manifests first for cache-friendly install
COPY package.json package-lock.json ./
COPY packages/server/package.json ./packages/server/

# Install only the server workspace and its deps
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
