FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY vite.config.ts index.html ./
COPY src ./src
COPY scripts ./scripts
COPY THIRD_PARTY_NOTICES.md ./
RUN pnpm build
RUN pnpm prune --prod

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node THIRD_PARTY_NOTICES.md ./
RUN mkdir /app/data && chown node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "dist/server/index.js"]
