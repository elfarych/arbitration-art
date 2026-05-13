"""
Production-specific Django settings.

Usage:
    DJANGO_SETTINGS_MODULE=arbitration_art_django.settings.production
"""

from .base import *  # noqa: F401, F403
from .base import env

DEBUG = False

ALLOWED_HOSTS = env("ALLOWED_HOSTS")


# Database

DATABASES = {
    "default": env.db("DATABASE_URL"),
}


# CORS — restrict to specific origins in production

CORS_ALLOWED_ORIGINS = env.list("CORS_ALLOWED_ORIGINS", default=[])

# CSRF trusted origins are required for Django 4+ admin/login POST when the
# request reaches Django via a TLS-terminating reverse proxy. Values must
# include scheme, e.g. https://art-api.jscode.kz. Comma-separated in env.
CSRF_TRUSTED_ORIGINS = env.list("CSRF_TRUSTED_ORIGINS", default=[])


# Reverse proxy / TLS termination
#
# Traefik (Dokploy) terminates TLS and forwards the original scheme via the
# X-Forwarded-Proto header. Without this setting Django sees the request as
# HTTP and, combined with SECURE_SSL_REDIRECT, produces an infinite 301 loop
# (ERR_TOO_MANY_REDIRECTS) because every forwarded request looks insecure.
#
# Only enable this when the proxy is fully trusted to overwrite the header on
# every inbound request. Traefik strips client-supplied X-Forwarded-* headers
# by default, which is the safe configuration we rely on here.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
USE_X_FORWARDED_HOST = True


# Security hardening

SECURE_BROWSER_XSS_FILTER = True
SECURE_CONTENT_TYPE_NOSNIFF = True
X_FRAME_OPTIONS = "DENY"
SECURE_SSL_REDIRECT = env.bool("SECURE_SSL_REDIRECT", default=True)
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SECURE_HSTS_SECONDS = 31536000
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_HSTS_PRELOAD = True
