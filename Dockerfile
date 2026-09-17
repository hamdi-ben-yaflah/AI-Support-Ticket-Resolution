# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553

FROM ${NODE_IMAGE} AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@11.21.0 --activate

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile

FROM dependencies AS operations-bundle
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN pnpm build:operations

FROM dependencies AS build
ARG APP_VERSION=development
ENV APP_VERSION=${APP_VERSION}
COPY . .
RUN pnpm build

FROM ${NODE_IMAGE} AS runtime
ARG APP_VERSION=unknown
ARG OCI_SOURCE=""
ARG OCI_REVISION=""
LABEL org.opencontainers.image.source=${OCI_SOURCE} \
      org.opencontainers.image.revision=${OCI_REVISION}

WORKDIR /app
RUN apt-get update && \
    apt-get install --only-upgrade --yes --no-install-recommends libpcre2-8-0 && \
    rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm && \
    rm -f /usr/local/bin/npm /usr/local/bin/npx
ENV APP_VERSION=${APP_VERSION} \
    ENABLE_LIVE_EVALUATIONS=false \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production \
    PORT=3000 \
    SKIP_KNOWLEDGE_INGESTION=false

COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=operations-bundle --chown=node:node /app/build/operations ./operations
COPY --chown=node:node drizzle ./drizzle
COPY --chown=node:node data/knowledge-base ./data/knowledge-base
COPY --chown=node:node --chmod=0555 scripts/container-entrypoint.sh ./container-entrypoint.sh

USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health/live',{signal:AbortSignal.timeout(2000)}).then(response=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/app/container-entrypoint.sh"]
