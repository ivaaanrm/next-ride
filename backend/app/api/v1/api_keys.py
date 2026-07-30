"""Gestión de API keys. Las usa el servicio scraper (aún sin implementar)."""

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select

from app.api.deps import CurrentUser, SessionDep
from app.core.security import generate_api_key
from app.models import ApiKey
from app.schemas.auth import ApiKeyCreate, ApiKeyCreated, ApiKeyRead

router = APIRouter(prefix="/api-keys", tags=["api-keys"])


@router.get("", response_model=list[ApiKeyRead])
async def list_api_keys(session: SessionDep, _: CurrentUser) -> list[ApiKey]:
    return list(await session.scalars(select(ApiKey).order_by(ApiKey.created_at.desc())))


@router.post("", response_model=ApiKeyCreated, status_code=status.HTTP_201_CREATED)
async def create_api_key(
    session: SessionDep, user: CurrentUser, payload: ApiKeyCreate
) -> ApiKeyCreated:
    raw, prefix, hashed = generate_api_key()
    api_key = ApiKey(
        name=payload.name, prefix=prefix, hashed_key=hashed, created_by_id=user.id
    )
    session.add(api_key)
    await session.commit()
    await session.refresh(api_key)
    # `raw` solo se devuelve aquí: en BD únicamente queda el hash.
    return ApiKeyCreated(**ApiKeyRead.model_validate(api_key).model_dump(), api_key=raw)


@router.delete("/{api_key_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_api_key(session: SessionDep, _: CurrentUser, api_key_id: int) -> None:
    api_key = await session.get(ApiKey, api_key_id)
    if api_key is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="API key no encontrada")
    api_key.is_active = False
    await session.commit()
