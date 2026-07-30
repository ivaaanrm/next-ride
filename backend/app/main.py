import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.router import api_router
from app.core.config import settings
from app.db.init_db import init_db

logging.basicConfig(
    level=settings.LOG_LEVEL,
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI):
    await init_db()
    logger.info(
        "%s arrancado (entorno=%s, IA=%s)",
        settings.PROJECT_NAME,
        settings.ENVIRONMENT,
        "activa" if settings.ai_enabled else "desactivada",
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
async def health() -> dict[str, object]:
    return {
        "status": "ok",
        "environment": settings.ENVIRONMENT,
        "ai_enabled": settings.ai_enabled,
    }
