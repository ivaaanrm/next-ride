"""Modelos que el usuario decide seguir en la plataforma."""

from decimal import Decimal

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.api.deps import CurrentUser, SessionDep
from app.models import CarModel, TrackedModel
from app.schemas.catalog import TrackedModelCreate, TrackedModelRead, TrackedModelUpdate
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
