# Using stable slim image for production
FROM python:3.13-slim

# Set environment variables for Python
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Force production settings inside the container so manage.py (migrate,
# collectstatic) and Gunicorn agree on the settings module without needing
# extra --settings flags.
ENV DJANGO_SETTINGS_MODULE=arbitration_art_django.settings.production

# Install minimal runtime system dependencies.
# psycopg[binary] ships its own libpq, so no build toolchain or libpq-dev is
# required here. libpq5 is kept as a safe runtime fallback for tooling.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    && rm -rf /var/lib/apt/lists/*

# Set unified working directory for the whole project
WORKDIR /app

# Upgrade pip to ensure latest resolution logic
RUN pip install --upgrade pip

# Copy and install dependencies first for better caching.
# production.txt pulls base.txt via `-r base.txt`, so the whole requirements/
# directory must be available before pip install.
COPY requirements/ ./requirements/
RUN pip install --no-cache-dir -r requirements/production.txt

# Copy the rest of the application code
COPY . .

# Make entrypoint script executable
RUN chmod +x /app/entrypoint.sh

# Django default port
EXPOSE 8000

# Start via entrypoint script
CMD ["/app/entrypoint.sh"]
