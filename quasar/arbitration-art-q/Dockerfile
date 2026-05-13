# syntax=docker/dockerfile:1.7

# =========================
# Stage 1 — builder
# =========================
# Builds the Quasar SPA. process.env.API_URL is read at BUILD time by Vite,
# so the API base URL must be passed as a build argument (Dokploy supports
# build args in the service config) — not as a runtime env var.
FROM node:22-slim AS builder

ENV CI=1
ENV NODE_ENV=development

# API_URL is baked into the bundle. Override per-deployment via Dokploy
# "Build Arguments". Falls back to the dev default so a smoke build works.
ARG API_URL=http://127.0.0.1:8000/api
ENV API_URL=${API_URL}

# Enable pnpm via corepack (project pins pnpm >= 9).
RUN corepack enable

WORKDIR /app

# Cache deps layer.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy sources required for the production build.
COPY tsconfig.json quasar.config.ts postcss.config.js index.html ./
COPY public ./public
COPY src ./src

# `quasar build` emits the SPA to dist/spa/.
RUN pnpm run build


# =========================
# Stage 2 — runtime (nginx)
# =========================
# Static SPA served by nginx. The frontend is a pure static bundle — no Node
# at runtime. SPA fallback is configured for hash mode (current default) and
# is also safe if vueRouterMode is later switched to history.
FROM nginx:1.27-alpine AS runtime

# Override the default site config with an SPA-friendly one.
RUN rm /etc/nginx/conf.d/default.conf

COPY <<'NGINX_CONF' /etc/nginx/conf.d/default.conf
server {
    listen 80;
    server_name _;

    root /usr/share/nginx/html;
    index index.html;

    # Long-cache hashed Vite assets, never cache index.html.
    location /assets/ {
        try_files $uri =404;
        access_log off;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location = /index.html {
        add_header Cache-Control "no-store";
    }

    # SPA fallback — required for history routing, harmless for hash mode.
    location / {
        try_files $uri $uri/ /index.html;
    }

    # gzip for text-like responses.
    gzip on;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;
    gzip_min_length 1024;
}
NGINX_CONF

COPY --from=builder /app/dist/spa /usr/share/nginx/html

EXPOSE 80

# nginx image has its own entrypoint that handles config templating and
# daemon-off start; nothing extra needed here.
