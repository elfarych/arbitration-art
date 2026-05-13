# Makefile — single-command developer workflow for arbitration-art-django.
#
# Common targets:
#   make start       — bring up Postgres, install deps, migrate, run dev server
#   make up          — same as `start` but does not start the dev server
#   make db-up       — start only the dockerized Postgres
#   make db-down     — stop Postgres (data persists in the named volume)
#   make db-reset    — stop Postgres AND drop its data volume (destructive)
#   make db-logs     — tail Postgres logs
#   make db-shell    — psql shell inside the Postgres container
#   make venv        — create venv if missing
#   make install     — install development requirements into venv
#   make migrate     — apply Django migrations
#   make runserver   — run Django dev server
#   make check       — run `manage.py check`
#   make superuser   — create a Django superuser (interactive)

PYTHON       ?= python3
VENV_DIR     := venv
VENV_PY      := $(VENV_DIR)/bin/python
VENV_PIP     := $(VENV_DIR)/bin/pip
COMPOSE      := docker compose
DB_SERVICE   := postgres

# Load .env so POSTGRES_* / DATABASE_URL are visible to recipe targets that
# need them (db-shell, db-wait). docker compose loads .env on its own.
ifneq (,$(wildcard ./.env))
include .env
export
endif

POSTGRES_USER     ?= arbitration_art
POSTGRES_DB       ?= arbitration_art
POSTGRES_HOST_PORT ?= 5434

.PHONY: start up db-up db-down db-reset db-logs db-shell db-wait \
        venv install migrate makemigrations check superuser runserver help

help:
	@echo "Targets:"
	@grep -E '^#   make ' Makefile | sed 's/^#   /  /'

# One-command bring-up: DB + deps + migrations + dev server.
start: up runserver

# Same as start but stops before runserver (useful for CI / scripted setups).
up: db-up venv install migrate

db-up:
	@echo ">>> Starting PostgreSQL container..."
	@$(COMPOSE) up -d $(DB_SERVICE)
	@$(MAKE) --no-print-directory db-wait

db-down:
	@$(COMPOSE) down

# Destructive: removes the named volume and all DB data.
db-reset:
	@echo ">>> Dropping Postgres data volume..."
	@$(COMPOSE) down -v

db-logs:
	@$(COMPOSE) logs -f $(DB_SERVICE)

db-shell:
	@$(COMPOSE) exec $(DB_SERVICE) psql -U "$(POSTGRES_USER)" -d "$(POSTGRES_DB)"

db-wait:
	@echo ">>> Waiting for PostgreSQL to be ready..."
	@for i in $$(seq 1 60); do \
		if $(COMPOSE) exec -T $(DB_SERVICE) pg_isready -U "$(POSTGRES_USER)" -d "$(POSTGRES_DB)" > /dev/null 2>&1; then \
			echo ">>> PostgreSQL is ready."; \
			exit 0; \
		fi; \
		sleep 1; \
	done; \
	echo "!!! PostgreSQL did not become ready in 60s"; \
	exit 1

venv:
	@if [ ! -x "$(VENV_PY)" ]; then \
		echo ">>> Creating virtualenv at $(VENV_DIR)..."; \
		$(PYTHON) -m venv $(VENV_DIR); \
	fi

install: venv
	@echo ">>> Installing development requirements..."
	@$(VENV_PIP) install --upgrade pip > /dev/null
	@$(VENV_PIP) install -r requirements/development.txt

migrate:
	@$(VENV_PY) manage.py migrate

makemigrations:
	@$(VENV_PY) manage.py makemigrations

check:
	@$(VENV_PY) manage.py check

superuser:
	@$(VENV_PY) manage.py createsuperuser

runserver:
	@$(VENV_PY) manage.py runserver
