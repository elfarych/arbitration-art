# syntax=docker/dockerfile:1.7

# =========================
# Stage 1 — builder
# =========================
# Compiles TypeScript to ./dist using full devDependencies (tsc, @types/*).
FROM node:22-slim AS builder

ENV CI=1
ENV NODE_ENV=development

# Enable pnpm via corepack. The lockfile is pnpm-lock.yaml and package.json
# pins pnpm >= 9; corepack resolves the right version automatically.
RUN corepack enable

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy sources required for the TypeScript build.
COPY tsconfig.json ./
COPY src ./src

# tsc -> ./dist (configured via tsconfig.json outDir).
RUN pnpm run build


# =========================
# Stage 2 — runtime
# =========================
# Slim production image with prod-only node_modules and compiled JS.
FROM node:22-slim AS runtime

ENV NODE_ENV=production
# tini gives proper PID 1 signal handling for graceful shutdown of Fastify.
ENV NODE_OPTIONS=--enable-source-maps

RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

# Production deps only — keeps the runtime image lean and avoids shipping tsc,
# tsx, @types/*, etc. into production.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Bring in the compiled output.
COPY --from=builder /app/dist ./dist

# Run as the non-root user that the node:* images ship with.
USER node

# Engine control-plane port (Django -> engine lifecycle requests).
EXPOSE 3001

# tini ensures SIGTERM from Dokploy/Docker reaches Node and Fastify can drain.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
