FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/storage-node/package.json apps/storage-node/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci
COPY tsconfig.base.json ./
COPY apps/storage-node apps/storage-node
RUN npm run build -w @depot-drive/storage-node
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/storage-node/dist ./apps/storage-node/dist
COPY --from=build /app/apps/storage-node/package.json ./apps/storage-node/package.json
CMD ["node", "apps/storage-node/dist/server.js"]
