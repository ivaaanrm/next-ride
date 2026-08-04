#!/bin/sh
# Migrar y luego arrancar. Nunca al revés.
#
# El esquema lo construyen dos cosas a la vez y no son intercambiables:
# `Base.metadata.create_all` (al arrancar la app) crea las **tablas** que
# falten, pero no toca una tabla que ya exista; Alembic lleva los **ALTER**.
# Sin este paso, una columna nueva no llega nunca a una base que ya tenía la
# tabla: la app arranca, sirve `/health` y revienta en la primera consulta que
# la seleccione.
#
# Que vaya antes de uvicorn y no en el despliegue es a propósito: así también
# migra un `docker compose up` a mano en el servidor, no solo el CD.
#
# El orden Alembic → `create_all` es seguro porque cada revisión se salta a sí
# misma si el cambio ya está: sobre una base vacía todas quedan en nada y
# `create_all` construye el esquema al día; sobre una base viva, la revisión
# hace su ALTER y `create_all` no encuentra nada que crear.
#
# Si las migraciones fallan, el contenedor no arranca: es lo que se quiere. El
# `--wait` del despliegue no lo ve sano y revierte, en vez de dejar en pie una
# app que va a dar 500 en cuanto alguien entre.
set -eu

if [ "${RUN_MIGRATIONS:-true}" != "true" ]; then
    echo "entrypoint: RUN_MIGRATIONS=${RUN_MIGRATIONS:-true}, se omiten las migraciones" >&2
else
    # `depends_on: service_healthy` ya espera al `pg_isready` de la base, pero
    # ese healthcheck puede pasar mientras Postgres todavía está terminando de
    # inicializarse. Unos reintentos cortos evitan un ciclo de reinicios por
    # una carrera de segundos; un fallo real (una migración rota) agota los
    # intentos y sale con error, que es lo que debe pasar.
    attempt=1
    until alembic upgrade head; do
        if [ "$attempt" -ge 5 ]; then
            echo "entrypoint: 'alembic upgrade head' falló tras $attempt intentos" >&2
            exit 1
        fi
        echo "entrypoint: migración fallida (intento $attempt), reintentando en 3s" >&2
        attempt=$((attempt + 1))
        sleep 3
    done
fi

# `exec` para que uvicorn sea el PID 1 y reciba el SIGTERM de `docker stop`:
# sin esto el apagado no es limpio y espera al timeout.
exec "$@"
