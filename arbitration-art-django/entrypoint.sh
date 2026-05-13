#!/bin/sh

# Stop execution on any error
set -e

# In the Dockerfile we copy the project into /app, so manage.py lives here
cd /app

echo "Applying database migrations..."
python manage.py migrate --noinput

echo "Collecting static files..."
python manage.py collectstatic --noinput

echo "Starting Gunicorn..."
# Worker count is overridable via GUNICORN_WORKERS (default: 3).
exec gunicorn \
    --bind 0.0.0.0:8000 \
    --workers "${GUNICORN_WORKERS:-3}" \
    --access-logfile - \
    --error-logfile - \
    arbitration_art_django.wsgi:application
