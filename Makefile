.DEFAULT_GOAL := help
COMPOSE := docker compose

.PHONY: help up down logs restart build seed shell-db shell-api ps clean

help: ## Muestra esta ayuda
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

up: ## Arranca todo el stack (build incluido)
	$(COMPOSE) up -d --build
	@echo ""
	@echo "  Frontend  http://localhost:$${FRONTEND_PORT:-8080}"
	@echo "  API docs  http://localhost:$${BACKEND_PORT:-8000}/docs"

down: ## Para el stack
	$(COMPOSE) down

clean: ## Para el stack y borra el volumen de la base de datos
	$(COMPOSE) down -v

build: ## Reconstruye las imágenes
	$(COMPOSE) build

restart: ## Reinicia el backend
	$(COMPOSE) restart backend

logs: ## Sigue los logs de todos los servicios
	$(COMPOSE) logs -f

ps: ## Estado de los servicios
	$(COMPOSE) ps

seed: ## Carga datos de demostración
	$(COMPOSE) exec backend python -m scripts.seed_demo

shell-api: ## Shell dentro del contenedor del backend
	$(COMPOSE) exec backend bash

shell-db: ## psql contra la base de datos
	$(COMPOSE) exec db psql -U $${POSTGRES_USER:-nextride} -d $${POSTGRES_DB:-nextride}
