# margo host — runtime container for the team-side comment server.
# Two-stage build: compile TypeScript with full devDependencies, then
# copy only the compiled output + production deps into a minimal Alpine
# runtime.
#
# Build (run from repo root):
#   docker build -f docker/host/Dockerfile -t margo-host:latest packages/host
#
# Or via compose (from docker/host/):
#   docker compose up -d
#
# The build context is `packages/host/` (not the repo root) so
# node_modules, demo apps, and .git stay out of the layer cache. A
# `.dockerignore` inside packages/host/ prunes the rest.

ARG NODE_VERSION=20-alpine

# ─── Build stage ─────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS builder

WORKDIR /src

# Install deps first so this layer caches when only source changes.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Then the source.
COPY tsconfig.json ./
COPY src ./src

RUN npm run build && rm -rf node_modules

# ─── Runtime stage ───────────────────────────────────────────────────────
FROM node:${NODE_VERSION}

# `git` is a hard runtime dep — the host shells out to it for each
# project's audit history.
RUN apk add --no-cache git

WORKDIR /app

COPY --from=builder /src/package.json /src/package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi && \
    npm cache clean --force

# Compiled output.
COPY --from=builder /src/dist ./dist

# Make the `margo-host` binary available on PATH inside the container so
# `docker exec margo-host-local margo-host list-users …` Just Works™.
RUN chmod +x /app/dist/cli.js && \
    ln -s /app/dist/cli.js /usr/local/bin/margo-host

# `/data` holds all per-project storage + users.json. Mount as a volume
# to persist across container restarts.
RUN mkdir -p /data && chown -R node:node /app /data
VOLUME ["/data"]
EXPOSE 7331

# Healthcheck for orchestrators. /healthz is unauthenticated by design
# so monitoring can hit it without provisioning a token.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:7331/healthz || exit 1

# Run as the non-root `node` user (uid 1000) baked into the base image.
USER node

ENTRYPOINT ["node", "/app/dist/cli.js", "run", "--data-dir", "/data", "--port", "7331"]
