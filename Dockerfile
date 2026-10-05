# syntax=docker/dockerfile:1.7
#
# Multi-stage build:
#   deps     → all dependencies (cached on package-lock.json)
#   build    → compile TypeScript, copy Lua scripts into dist/
#   prod-deps→ production dependencies only
#   runtime  → slim, non-root, healthchecked; only dist/, prod node_modules and migrations
#   fake-provider → dev/demo/load-test upstream (target it explicitly; never deployed)
#
# Same image runs the gateway (default CMD) and migrations (`node dist/migrate.js`).

ARG NODE_IMAGE=node:22.23.1-bookworm-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts --no-audit --no-fund

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    METRICS_PORT=9464
WORKDIR /app
# Files are owned by root and read-only for the runtime user: the process cannot modify its code.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY package.json ./
USER node
EXPOSE 8080 9464
# Liveness only (/healthz). Readiness (/readyz) is for the orchestrator's traffic decisions.
# No curl in the slim image: use Node's built-in fetch.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Exec form: node is PID 1 and receives SIGTERM directly (graceful shutdown in src/server.ts).
STOPSIGNAL SIGTERM
CMD ["node", "dist/server.js"]

# --- Dev/demo only: the OpenAI-compatible fake provider (docker compose --profile app) ---------
FROM deps AS fake-provider
COPY tsconfig.json ./
COPY scripts ./scripts
USER node
EXPOSE 8090
CMD ["node", "--import", "tsx", "scripts/fake-provider-server.ts", "--port", "8090"]

# The default build target is the gateway runtime.
FROM runtime
