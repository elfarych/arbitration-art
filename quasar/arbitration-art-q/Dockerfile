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
# "Build Arguments". The default points at the production Django host so a
# build without explicit arguments still produces a working bundle.
ARG API_URL=https://art-api.jscode.kz/api
ENV API_URL=${API_URL}

# Enable pnpm via corepack (project pins pnpm >= 9).
RUN corepack enable

WORKDIR /app

# Copy the full project before install. The `postinstall` script in
# package.json runs `quasar prepare`, which requires quasar.config.ts (and
# the rest of the project layout) to be present in cwd. Splitting deps and
# sources into separate layers — the usual Node.js caching pattern — makes
# prepare abort with "must be executed inside a Quasar project folder".
# Dokploy clones the repo fresh on every deploy, so the lost layer-cache
# would not have helped anyway.
COPY . .

RUN pnpm install --frozen-lockfile

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

    # Exchange REST proxies — prod counterpart to quasar.config.ts devServer.proxy.
    # Frontend (mexcApi.ts, binanceApi.ts, bybitApi.ts) hardcodes relative paths
    # like `/mexc-api/...`. Without these locations, prod nginx would fall through
    # to the SPA fallback below and return index.html, which axios then fails to
    # parse as JSON. Trailing slash on proxy_pass strips the matched prefix —
    # equivalent to the dev-proxy `rewrite` rule. WS streams (wss://...) still
    # go direct to exchanges from the browser (see DOCS §30.3).
    location /binance-api/ {
        proxy_pass https://fapi.binance.com/;
        proxy_ssl_server_name on;
        proxy_http_version 1.1;
        proxy_set_header Host fapi.binance.com;
        proxy_set_header Origin "";
        proxy_set_header User-Agent $http_user_agent;
    }
    location /binance-spot-api/ {
        proxy_pass https://api.binance.com/;
        proxy_ssl_server_name on;
        proxy_http_version 1.1;
        proxy_set_header Host api.binance.com;
        proxy_set_header Origin "";
        proxy_set_header User-Agent $http_user_agent;
    }
    location /mexc-api/ {
        proxy_pass https://contract.mexc.com/;
        proxy_ssl_server_name on;
        proxy_http_version 1.1;
        proxy_set_header Host contract.mexc.com;
        proxy_set_header Origin "";
        proxy_set_header User-Agent $http_user_agent;
    }
    location /bybit-api/ {
        proxy_pass https://api.bybit.com/;
        proxy_ssl_server_name on;
        proxy_http_version 1.1;
        proxy_set_header Host api.bybit.com;
        proxy_set_header Origin "";
        proxy_set_header User-Agent $http_user_agent;
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
