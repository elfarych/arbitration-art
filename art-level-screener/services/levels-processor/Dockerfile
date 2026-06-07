# syntax=docker/dockerfile:1.7
#
# levels-processor — computes horizontal levels from candles in Redis (worker).
# Reads connector candles, writes levels:* every ~10s. No HTTP port.

# =========================
# Stage 1 — builder
# =========================
# Compiles TypeScript to ./dist using full devDependencies (tsc, @types/*).
FROM node:22-slim AS builder

ENV CI=1
ENV NODE_ENV=development

WORKDIR /app

# Install dependencies first for better layer caching.
# npm ci installs exactly the versions pinned in package-lock.json.
COPY package.json package-lock.json ./
RUN npm ci

# Copy sources required for the TypeScript build.
COPY tsconfig.json ./
COPY src ./src

# tsc -> ./dist (configured via tsconfig.json outDir).
RUN npm run build


# =========================
# Stage 2 — runtime
# =========================
# Slim production image with prod-only node_modules and compiled JS.
FROM node:22-slim AS runtime

ENV NODE_ENV=production
# Source maps keep stack traces pointing at .ts (tsconfig sourceMap: true).
ENV NODE_OPTIONS=--enable-source-maps

# tini gives proper PID 1 signal handling for graceful shutdown.
RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Production deps only — keeps the runtime image lean and avoids shipping tsc,
# tsx, @types/*, etc. into production.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Bring in the compiled output.
COPY --from=builder /app/dist ./dist

# Run as the non-root user that the node:* images ship with.
USER node

# tini ensures SIGTERM from Dokploy/Docker reaches Node so it can drain.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
