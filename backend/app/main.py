import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.v1.router import api_router
from app.core.config import settings
from app.db.init_db import init_db
from app.db.schema_version import SchemaVersion, read_schema_version

logging.basicConfig(
    level=settings.LOG_LEVEL,
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


#: Se resuelve una vez al arrancar y no en cada `/health`: el healthcheck del
#: contenedor pega cada 15 s y esto lee de la base y del disco. El esquema no
#: cambia bajo un proceso vivo; si cambia, el contenedor se reinicia y se
#: vuelve a mirar.
_schema = SchemaVersion(current=None, head=None, up_to_date=None)


@asynccontextmanager
async def lifespan(_: FastAPI):
    global _schema

    await init_db()
    _schema = await read_schema_version()
    logger.info(
        "%s arrancado (entorno=%s, IA=%s, esquema=%s)",
        settings.PROJECT_NAME,
        settings.ENVIRONMENT,
        "activa" if settings.ai_enabled else "desactivada",
        _schema.current or "sin migrar",
    )
    yield


app = FastAPI(
    title="next-ride API",
    description=(
        "Agrega ofertas de coches de distintos dealers, calcula métricas de valor y "
        "las rankea con un agente de IA."
    ),
    version="0.1.0",
    lifespan=lifespan,
    openapi_url=f"{settings.API_V1_PREFIX}/openapi.json",
    docs_url="/docs",
    redoc_url=None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix=settings.API_V1_PREFIX)


@app.get("/health", tags=["meta"])
async def health() -> JSONResponse:
    """Sano = puede servir. Con el esquema desfasado no puede, y lo dice con 503.

    Antes devolvía siempre 200 sin mirar la base: un despliegue al que le
    faltaba una migración pasaba el healthcheck del contenedor y el `curl` final
    del CD, se daba por bueno, y la app respondía 500 en la primera consulta que
    tocara la columna que faltaba. Un 503 aquí hace que el `--wait` no vea el
    contenedor sano y que el despliegue revierta solo.
    """
    body = {
        "status": "stale_schema" if _schema.is_stale else "ok",
        "environment": settings.ENVIRONMENT,
        "ai_enabled": settings.ai_enabled,
        "schema": {
            "current": _schema.current,
            "head": _schema.head,
            "up_to_date": _schema.up_to_date,
        },
    }
    return JSONResponse(body, status_code=503 if _schema.is_stale else 200)
