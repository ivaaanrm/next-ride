"""Dependencias compartidas: sesión de BD, usuario autenticado y API keys."""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, HTTPException, Security, status
from fastapi.security import APIKeyHeader, OAuth2PasswordBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import api_key_prefix, decode_token, hash_api_key
from app.db.session import get_session
from app.models import ApiKey, User, utcnow

oauth2_scheme = OAuth2PasswordBearer(
    tokenUrl=f"{settings.API_V1_PREFIX}/auth/token", auto_error=False
)
api_key_scheme = APIKeyHeader(name="X-API-Key", auto_error=False)

SessionDep = Annotated[AsyncSession, Depends(get_session)]

_CREDENTIALS_ERROR = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Credenciales no válidas",
    headers={"WWW-Authenticate": "Bearer"},
)


async def get_current_user(
    session: SessionDep,
    token: Annotated[str | None, Depends(oauth2_scheme)] = None,
) -> User:
    if not token:
        raise _CREDENTIALS_ERROR

    payload = decode_token(token, "access")
    if payload is None:
        raise _CREDENTIALS_ERROR

    try:
        user_id = int(payload["sub"])
    except (KeyError, TypeError, ValueError):
        raise _CREDENTIALS_ERROR from None

    user = await session.get(User, user_id)
    if user is None:
        raise _CREDENTIALS_ERROR
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Usuario desactivado"
        )
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


async def get_current_superuser(user: CurrentUser) -> User:
    if not user.is_superuser:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Se requieren permisos de administrador",
        )
    return user


SuperUser = Annotated[User, Depends(get_current_superuser)]


async def resolve_api_key(session: AsyncSession, raw_key: str) -> ApiKey | None:
    prefix = api_key_prefix(raw_key)
    if not prefix:
        return None
    candidate = await session.scalar(
        select(ApiKey).where(
            ApiKey.prefix == prefix,
            ApiKey.hashed_key == hash_api_key(raw_key),
            ApiKey.is_active.is_(True),
        )
    )
    if candidate is None:
        return None
    candidate.last_used_at = utcnow()
    await session.commit()
    return candidate


class IngestPrincipal:
    """Quién está ingestando: un usuario logueado o el servicio scraper."""

    def __init__(self, user: User | None = None, api_key: ApiKey | None = None) -> None:
        self.user = user
        self.api_key = api_key

    @property
    def label(self) -> str:
        if self.user:
            return f"user:{self.user.email}"
        if self.api_key:
            return f"api_key:{self.api_key.name}"
        return "unknown"


async def require_ingest_principal(
    session: SessionDep,
    token: Annotated[str | None, Depends(oauth2_scheme)] = None,
    raw_api_key: Annotated[str | None, Security(api_key_scheme)] = None,
) -> IngestPrincipal:
    """Los endpoints de ingesta aceptan JWT (persona) o X-API-Key (scraper)."""
    if raw_api_key:
        api_key = await resolve_api_key(session, raw_api_key)
        if api_key is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, detail="API key no válida"
            )
        return IngestPrincipal(api_key=api_key)

    if token:
        user = await get_current_user(session=session, token=token)
        return IngestPrincipal(user=user)

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Aporta un Bearer token o una cabecera X-API-Key",
        headers={"WWW-Authenticate": "Bearer"},
    )


IngestDep = Annotated[IngestPrincipal, Depends(require_ingest_principal)]
