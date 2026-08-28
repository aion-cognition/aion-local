# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 falls back to compiling from source when no prebuild matches the image arch.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/core/package.json ./packages/core/
COPY packages/mcp/package.json ./packages/mcp/
COPY packages/cli/package.json ./packages/cli/
RUN npm ci

COPY packages ./packages
RUN npm run build && npm prune --omit=dev


FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# `aion init` orchestrates the compose services from inside this container.
COPY --from=docker:29.7.2-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker/compose-bin:v5.1.4 /docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages

ENTRYPOINT ["node", "/app/packages/cli/dist/main.js"]
