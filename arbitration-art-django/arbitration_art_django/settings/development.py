"""
Development-specific Django settings.

Usage:
    DJANGO_SETTINGS_MODULE=arbitration_art_django.settings.development
"""

from .base import *  # noqa: F401, F403
from .base import env

# SECURITY WARNING: don't run with debug turned on in production!
DEBUG = True

ALLOWED_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0"]  # noqa: S104


# Database

DATABASES = {
    "default": env.db("DATABASE_URL"),
}


# CORS — allow all in development

CORS_ALLOW_ALL_ORIGINS = True


# DRF — add browsable API in development

REST_FRAMEWORK["DEFAULT_RENDERER_CLASSES"] += [  # type: ignore[name-defined]  # noqa: F405
    "rest_framework.renderers.BrowsableAPIRenderer",
]


# Email backend — console output for development

EMAIL_BACKEND = "django.core.mail.backends.console.EmailBackend"
