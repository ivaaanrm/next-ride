.DEFAULT_GOAL := help
COMPOSE := docker compose

# El stack de producción se maneja desde el servidor, dentro de DEPLOY_PATH:
# `compose.prod.yml` interpola `${VAR:?...}`, así que hasta un `restart`
# necesita el `.env.prod` de ahí (sin versionar).
ENV_PROD := .env.prod
COMPOSE_PROD := docker compose --env-file $(ENV_PROD) -f compose.prod.yml

.PHONY: help up down logs restart build seed shell-db shell-api ps clean \
	prod-restart prod-recreate require-env-prod

help: ## Muestra esta ayuda
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

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

# --- Producción (ejecutar en el servidor) -----------------------------------

require-env-prod:
	@test -f $(ENV_PROD) || { \
		echo "Falta $(ENV_PROD). Los objetivos prod-* se ejecutan en el servidor,"; \
		echo "dentro de DEPLOY_PATH, donde vive el fichero de secretos."; \
		exit 1; \
	}

prod-restart: require-env-prod ## Reinicia el stack de producción, sin recrear ni reconstruir
	$(COMPOSE_PROD) restart
	@echo ""
	$(COMPOSE_PROD) ps

# `restart` reinicia el proceso dentro del contenedor que ya existe, así que no
# se entera de los cambios en `.env.prod` ni en `compose.prod.yml`: el entorno
# se fija al crear el contenedor. Para eso, este otro. Sigue sin reconstruir
# imágenes: un cambio de código se despliega con el workflow o, a mano, con
# `up -d --build` (ver .env.prod.example).
prod-recreate: require-env-prod ## Recrea los contenedores de producción aplicando .env.prod
	$(COMPOSE_PROD) up -d --force-recreate --wait --wait-timeout 300
	@echo ""
	$(COMPOSE_PROD) ps
