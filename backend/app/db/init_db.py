"""Arranque del esquema y datos iniciales (idempotente)."""

from __future__ import annotations

import logging

from sqlalchemy import select

from app.core.config import settings
from app.core.security import api_key_prefix, hash_api_key, hash_password
from app.db.session import SessionFactory, engine
from app.models import ApiKey, Base, User

logger = logging.getLogger(__name__)


async def create_schema() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    logger.info("Esquema verificado/creado")


async def seed_superuser() -> None:
    if not (settings.FIRST_SUPERUSER_EMAIL and settings.FIRST_SUPERUSER_PASSWORD):
        return

    email = settings.FIRST_SUPERUSER_EMAIL.lower()
    async with SessionFactory() as session:
        existing = await session.scalar(select(User).where(User.email == email))
        if existing:
            return
        session.add(
            User(
                email=email,
                hashed_password=hash_password(settings.FIRST_SUPERUSER_PASSWORD),
                full_name="Administrador",
                is_superuser=True,
                is_active=True,
            )
        )
        await session.commit()
        logger.info("Superusuario creado: %s", email)


async def seed_bootstrap_api_key() -> None:
    """Registra la API key con la que el scraper podrá ingestar desde el minuto cero."""
    raw = settings.BOOTSTRAP_SCRAPER_API_KEY
    if not raw:
        return
    prefix = api_key_prefix(raw)
    if not prefix:
        logger.warning(
            "BOOTSTRAP_SCRAPER_API_KEY ignorada: el formato debe ser nr_<prefijo>_<secreto>"
        )
        return

    hashed = hash_api_key(raw)
    async with SessionFactory() as session:
        existing = await session.scalar(select(ApiKey).where(ApiKey.hashed_key == hashed))
        if existing:
            if not existing.is_active:
                existing.is_active = True
                await session.commit()
            return
        session.add(
            ApiKey(name="scraper (bootstrap)", prefix=prefix, hashed_key=hashed, is_active=True)
        )
        await session.commit()
        logger.info("API key de bootstrap registrada (prefijo %s)", prefix)


async def init_db() -> None:
    if settings.AUTO_CREATE_TABLES:
        await create_schema()
    await seed_superuser()
    await seed_bootstrap_api_key()
