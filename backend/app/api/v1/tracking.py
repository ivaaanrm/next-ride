"""Modelos que el usuario decide seguir en la plataforma."""

from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.api.deps import CurrentUser, SessionDep
from app.models import CarModel, TrackedModel
from app.schemas.catalog import (
    TrackedModelBulkCreate,
    TrackedModelCreate,
    TrackedModelRead,
    TrackedModelUpdate,
)
from app.services.catalog import get_or_create_car_model

router = APIRouter(prefix="/tracked-models", tags=["tracked-models"])


def _as_decimal(value: float | None) -> Decimal | None:
    return Decimal(str(value)) if value is not None else None


@router.get("", response_model=list[TrackedModelRead])
async def list_tracked(session: SessionDep, user: CurrentUser) -> list[TrackedModel]:
    stmt = (
        select(TrackedModel)
        .where(TrackedModel.user_id == user.id)
        .options(selectinload(TrackedModel.car_model))
        .order_by(TrackedModel.created_at.desc())
    )
    return list(await session.scalars(stmt))


@router.post("", response_model=TrackedModelRead, status_code=status.HTTP_201_CREATED)
async def track_model(
    session: SessionDep, user: CurrentUser, payload: TrackedModelCreate
) -> TrackedModel:
    """Sigue un modelo con sus criterios. Crea el modelo si se identifica por marca y modelo."""
    if payload.car_model_id is not None:
        car_model = await session.get(CarModel, payload.car_model_id)
        if car_model is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Modelo no encontrado"
            )
    else:
        # El validador del esquema garantiza que aquí hay make y model.
        car_model = await get_or_create_car_model(
            session, payload.make or "", payload.model or "", payload.trim
        )

    if payload.reference_price is not None and car_model.reference_price is None:
        car_model.reference_price = _as_decimal(payload.reference_price)

    existing = await session.scalar(
        select(TrackedModel).where(
            TrackedModel.user_id == user.id,
            TrackedModel.car_model_id == car_model.id,
        )
    )
    # Re-seguir un modelo ya seguido actualiza los criterios en lugar de fallar.
    tracked = existing or TrackedModel(user_id=user.id, car_model_id=car_model.id)
    tracked.target_price = _as_decimal(payload.target_price)
    tracked.max_mileage_km = payload.max_mileage_km
    tracked.min_year = payload.min_year
    tracked.notes = payload.notes
    tracked.is_active = True
    if existing is None:
        session.add(tracked)

    await session.commit()
    await session.refresh(tracked, attribute_names=["car_model"])
    return tracked


# Las dos rutas `/bulk` van **antes** que las que llevan un id: FastAPI resuelve
# por orden de declaración y «bulk» no es un entero.
@router.post("/bulk", response_model=list[TrackedModelRead], status_code=status.HTTP_201_CREATED)
async def track_models(
    session: SessionDep, user: CurrentUser, payload: TrackedModelBulkCreate
) -> list[TrackedModel]:
    """Sigue varias versiones con los mismos criterios, en una transacción.

    Es cómo se sigue un binomio marca-modelo entero desde la vista de modelos.
    Como en el alta de una sola, re-seguir actualiza los criterios en vez de fallar.
    """
    ids = list(dict.fromkeys(payload.car_model_ids))
    found = set(
        await session.scalars(select(CarModel.id).where(CarModel.id.in_(ids)))
    )
    missing = [model_id for model_id in ids if model_id not in found]
    if missing:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Modelos no encontrados: {', '.join(str(i) for i in missing)}",
        )

    existing = {
        row.car_model_id: row
        for row in await session.scalars(
            select(TrackedModel).where(
                TrackedModel.user_id == user.id, TrackedModel.car_model_id.in_(ids)
            )
        )
    }

    tracked = []
    for model_id in ids:
        row = existing.get(model_id) or TrackedModel(user_id=user.id, car_model_id=model_id)
        row.target_price = _as_decimal(payload.target_price)
        row.max_mileage_km = payload.max_mileage_km
        row.min_year = payload.min_year
        row.notes = payload.notes
        row.is_active = True
        if model_id not in existing:
            session.add(row)
        tracked.append(row)

    await session.commit()
    for row in tracked:
        await session.refresh(row, attribute_names=["car_model"])
    return tracked


@router.delete("/bulk", status_code=status.HTTP_204_NO_CONTENT)
async def untrack_models(
    session: SessionDep,
    user: CurrentUser,
    car_model_ids: Annotated[
        str, Query(description="Ids de modelo separados por coma")
    ],
) -> None:
    """Deja de seguir varias versiones. No falla si alguna ya no se seguía.

    A diferencia del alta, esto es idempotente a propósito: se dispara sobre un
    binomio entero, donde lo normal es que solo algunas de sus versiones tuvieran
    seguimiento, y un 404 por las demás no describiría ningún error.
    """
    ids = [int(part) for part in car_model_ids.split(",") if part.strip().lstrip("-").isdigit()]
    if not ids:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Aporta al menos un id de modelo en 'car_model_ids'",
        )

    rows = await session.scalars(
        select(TrackedModel).where(
            TrackedModel.user_id == user.id, TrackedModel.car_model_id.in_(ids)
        )
    )
    for row in rows:
        await session.delete(row)
    await session.commit()


@router.patch("/{tracked_id}", response_model=TrackedModelRead)
async def update_tracked(
    session: SessionDep, user: CurrentUser, tracked_id: int, payload: TrackedModelUpdate
) -> TrackedModel:
    tracked = await session.get(TrackedModel, tracked_id)
    if tracked is None or tracked.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Seguimiento no encontrado")

    data = payload.model_dump(exclude_unset=True)
    if "target_price" in data:
        data["target_price"] = _as_decimal(data["target_price"])
    for field, value in data.items():
        setattr(tracked, field, value)

    await session.commit()
    await session.refresh(tracked, attribute_names=["car_model"])
    return tracked


@router.delete("/{car_model_id}", status_code=status.HTTP_204_NO_CONTENT)
async def untrack_model(session: SessionDep, user: CurrentUser, car_model_id: int) -> None:
    """Deja de seguir un modelo. Se identifica por `car_model_id`, no por el id del seguimiento."""
    tracked = await session.scalar(
        select(TrackedModel).where(
            TrackedModel.user_id == user.id, TrackedModel.car_model_id == car_model_id
        )
    )
    if tracked is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Seguimiento no encontrado")
    await session.delete(tracked)
    await session.commit()
