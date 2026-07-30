from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import func, select

from app.api.deps import CurrentUser, SessionDep
from app.models import CarModel, RankingRun, RunStatus, TrackedModel
from app.schemas.catalog import (
    CarModelCreate,
    CarModelRead,
    CarModelUpdate,
    CarModelWithStats,
    TrackedModelPrefs,
)
from app.services.catalog import slugify
from app.services.metrics import model_price_stats

router = APIRouter(prefix="/car-models", tags=["car-models"])


async def _with_stats(
    session: SessionDep, user_id: int, models: list[CarModel]
) -> list[CarModelWithStats]:
    if not models:
        return []

    model_ids = [m.id for m in models]
    stats = await model_price_stats(session, model_ids)

    tracked_rows = list(
        await session.scalars(
            select(TrackedModel).where(
                TrackedModel.user_id == user_id,
                TrackedModel.car_model_id.in_(model_ids),
                TrackedModel.is_active.is_(True),
            )
        )
    )
    tracked = {row.car_model_id: TrackedModelPrefs.model_validate(row) for row in tracked_rows}

    ranked_rows = (
        await session.execute(
            select(RankingRun.car_model_id, func.max(RankingRun.created_at))
            .where(
                RankingRun.car_model_id.in_(model_ids),
                RankingRun.status == RunStatus.COMPLETED,
            )
            .group_by(RankingRun.car_model_id)
        )
    ).all()
    last_ranked = {row[0]: row[1] for row in ranked_rows}

    result = []
    for model in models:
        stat = stats.get(model.id)
        prefs = tracked.get(model.id)
        result.append(
            CarModelWithStats(
                **CarModelRead.model_validate(model).model_dump(),
                active_offers=stat.count if stat else 0,
                min_price=stat.min_price if stat else None,
                median_price=round(stat.median_price, 2)
                if stat and stat.median_price
                else None,
                max_price=stat.max_price if stat else None,
                dealers_count=stat.dealers_count if stat else 0,
                is_tracked=prefs is not None,
                tracking=prefs,
                last_ranked_at=last_ranked.get(model.id),
            )
        )
    return result


@router.get("", response_model=list[CarModelWithStats])
async def list_car_models(
    session: SessionDep,
    user: CurrentUser,
    q: Annotated[str | None, Query(description="Busca por marca o modelo")] = None,
    tracked_only: Annotated[bool, Query()] = False,
    include_inactive: Annotated[bool, Query()] = False,
) -> list[CarModelWithStats]:
    stmt = select(CarModel).order_by(CarModel.make, CarModel.model, CarModel.trim)
    if not include_inactive:
        stmt = stmt.where(CarModel.is_active.is_(True))
    if q:
        pattern = f"%{q.lower()}%"
        stmt = stmt.where(
            func.lower(CarModel.make).like(pattern)
            | func.lower(CarModel.model).like(pattern)
            | func.lower(CarModel.slug).like(pattern)
        )
    if tracked_only:
        stmt = stmt.join(
            TrackedModel,
            (TrackedModel.car_model_id == CarModel.id)
            & (TrackedModel.user_id == user.id)
            & (TrackedModel.is_active.is_(True)),
        )

    models = list(await session.scalars(stmt))
    return await _with_stats(session, user.id, models)


@router.post("", response_model=CarModelRead, status_code=status.HTTP_201_CREATED)
async def create_car_model(
    session: SessionDep, _: CurrentUser, payload: CarModelCreate
) -> CarModel:
    slug = slugify(payload.make, payload.model, payload.trim)
    if await session.scalar(select(CarModel.id).where(CarModel.slug == slug)):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail=f"Ya existe el modelo '{slug}'"
        )

    car_model = CarModel(slug=slug, **payload.model_dump())
    session.add(car_model)
    await session.commit()
    await session.refresh(car_model)
    return car_model


@router.get("/{car_model_id}", response_model=CarModelWithStats)
async def get_car_model(
    session: SessionDep, user: CurrentUser, car_model_id: int
) -> CarModelWithStats:
    car_model = await session.get(CarModel, car_model_id)
    if car_model is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Modelo no encontrado")
    return (await _with_stats(session, user.id, [car_model]))[0]


@router.patch("/{car_model_id}", response_model=CarModelRead)
async def update_car_model(
    session: SessionDep, _: CurrentUser, car_model_id: int, payload: CarModelUpdate
) -> CarModel:
    car_model = await session.get(CarModel, car_model_id)
    if car_model is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Modelo no encontrado")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(car_model, field, value)
    await session.commit()
    await session.refresh(car_model)
    return car_model
