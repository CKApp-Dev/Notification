FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY firebase/worker/package.json firebase/worker/package-lock.json ./
RUN npm ci --ignore-scripts
COPY firebase/worker/tsconfig.json ./
COPY firebase/worker/src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/lib ./lib
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node firebase/cloud-run/adapter.cjs firebase/cloud-run/server.cjs ./
USER node
CMD ["node", "server.cjs"]
