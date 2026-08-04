"""¿Está la base al día con las migraciones?

El entrypoint del contenedor migra antes de arrancar, así que en un despliegue
normal la respuesta siempre es sí. Esto es la red debajo: cubre el arranque con
`RUN_MIGRATIONS=false`, el `uvicorn` lanzado a mano y la base que alguien movió
por debajo. Un esquema desfasado no da la cara al arrancar —la app levanta
igual— sino en la primera consulta que toque la columna que falta, y para
entonces el despliegue ya se ha dado por bueno.

Cablearlo a `/health` invierte eso: el contenedor no llega a `healthy`, el
`--wait` del despliegue falla y el CD revierte solo.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import Connection

from app.db.session import engine

logger = logging.getLogger(__name__)

#: `app/db/schema_version.py` → la raíz del backend, donde están `alembic.ini` y
#: el directorio de revisiones. Vale igual en el contenedor (`/app`) que en un
#: `uvicorn` lanzado desde el repositorio.
_BACKEND_ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class SchemaVersion:
    """Revisión aplicada frente a la última escrita.

    `up_to_date` es `None` cuando no se ha podido averiguar (no cuando está
    desfasado): sin saberlo no se tumba una app que por lo demás funciona.
    """

    current: str | None
    head: str | None
    up_to_date: bool | None

    @property
    def is_stale(self) -> bool:
        return self.up_to_date is False


def _head_revision() -> str | None:
    config = Config(str(_BACKEND_ROOT / "alembic.ini"))
    # `script_location` viene relativo en el ini y Alembic lo resolvería contra
    # el directorio de trabajo; fijarlo absoluto hace la lectura independiente
    # de desde dónde se arranque el proceso.
    config.set_main_option("script_location", str(_BACKEND_ROOT / "alembic"))
    return ScriptDirectory.from_config(config).get_current_head()


def _current_revision(connection: Connection) -> str | None:
    return MigrationContext.configure(connection).get_current_revision()


async def read_schema_version() -> SchemaVersion:
    """La comparación, sin propagar errores: esto no debe tumbar el arranque."""
    try:
        head = _head_revision()
        async with engine.connect() as conn:
            current = await conn.run_sync(_current_revision)
    except Exception:  # noqa: BLE001 - da igual por qué falle: se ignora igual
        logger.warning("No se pudo comprobar la revisión del esquema", exc_info=True)
        return SchemaVersion(current=None, head=None, up_to_date=None)

    version = SchemaVersion(current=current, head=head, up_to_date=current == head)
    if version.is_stale:
        logger.error(
            "Esquema desfasado: la base está en %s y el código espera %s. "
            "Ejecuta 'alembic upgrade head'.",
            current or "sin migrar",
            head,
        )
    return version
