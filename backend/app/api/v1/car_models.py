from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import func, select, tuple_

from app.api.deps import CurrentUser, SessionDep
from app.models import CarModel, RankingRun, RunStatus, TrackedModel
from app.schemas.catalog import (
    CarModelCreate,
    CarModelGroup,
    CarModelRead,
    CarModelUpdate,
    CarModelWithStats,
    TrackedModelPrefs,
)
from app.services.catalog import slugify
from app.services.metrics import make_model_price_stats, model_price_stats

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


def _median(values: list[float]) -> float | None:
    """Mediana de una lista ya ordenada. Vacía devuelve `None`."""
    if not values:
        return None
    middle = len(values) // 2
    if len(values) % 2:
        return values[middle]
    return round((values[middle - 1] + values[middle]) / 2, 2)


# La ruta va **antes** de `/{car_model_id}`: FastAPI resuelve por orden de
# declaración y «groups» no es un entero, así que declarada después daría un 422.
@router.get("/groups", response_model=list[CarModelGroup])
async def list_car_model_groups(
    session: SessionDep,
    user: CurrentUser,
    q: Annotated[str | None, Query(description="Busca por marca, modelo o versión")] = None,
    tracked_only: Annotated[bool, Query()] = False,
    include_inactive: Annotated[bool, Query()] = False,
) -> list[CarModelGroup]:
    """El catálogo por binomio marca-modelo, con las versiones colgando.

    `car_models` está partido por acabado —un «Audi A3» son veintitrés filas— y
    a ese nivel el listado enseña una oferta por fila, con mínimo, mediana y
    máximo iguales: tres columnas para decir un precio. El binomio es la unidad
    con la que se mira un mercado, la misma que ya usa `/analytics/segments`.
    """
    make_key = func.lower(CarModel.make)
    model_key = func.lower(CarModel.model)

    # Dos pasos: primero qué binomios casan con el filtro, luego *todas* sus
    # versiones. Buscar «sportback» encuentra el A3 entero y no tres de sus
    # veintitrés versiones: un grupo recortado daría una mediana que no es la del
    # mercado que dice describir.
    keys_stmt = select(make_key, model_key).select_from(CarModel).distinct()
    if not include_inactive:
        keys_stmt = keys_stmt.where(CarModel.is_active.is_(True))
    if q:
        pattern = f"%{q.lower()}%"
        keys_stmt = keys_stmt.where(
            make_key.like(pattern)
            | model_key.like(pattern)
            | func.lower(CarModel.slug).like(pattern)
        )
    if tracked_only:
        # Basta con seguir una versión para que el binomio esté en la lista.
        keys_stmt = keys_stmt.join(
            TrackedModel,
            (TrackedModel.car_model_id == CarModel.id)
            & (TrackedModel.user_id == user.id)
            & (TrackedModel.is_active.is_(True)),
        )

    pairs = [(row[0], row[1]) for row in (await session.execute(keys_stmt)).all()]
    if not pairs:
        return []

    # La clave viaja desde SQL y no se recalcula en Python: es la que agrupa los
    # precios en `make_model_price_stats`, y dos minúsculas distintas (las de
    # Postgres y las de `str.lower`) dejarían a un binomio sin sus agregados.
    stmt = (
        select(CarModel, (make_key + "|" + model_key).label("key"))
        .where(tuple_(make_key, model_key).in_(pairs))
        # Se ordena por la clave, no por la columna: si no, las dos grafías de un
        # mismo binomio se separarían y sus versiones dejarían de ser contiguas.
        .order_by(make_key, model_key, func.lower(CarModel.trim))
    )
    if not include_inactive:
        stmt = stmt.where(CarModel.is_active.is_(True))

    rows = (await session.execute(stmt)).all()
    models = [row[0] for row in rows]
    # `_with_stats` respeta el orden que recibe, así que la clave de la fila `i`
    # es la de la versión `i`.
    variants = await _with_stats(session, user.id, models)
    aggregates = await make_model_price_stats(session, [model.id for model in models])

    # El ranking es del binomio, así que su fecha también: se pregunta por clave.
    ranked_rows = (
        await session.execute(
            select(RankingRun.make_model_key, func.max(RankingRun.created_at))
            .where(
                RankingRun.make_model_key.in_({row[1] for row in rows}),
                RankingRun.status == RunStatus.COMPLETED,
            )
            .group_by(RankingRun.make_model_key)
        )
    ).all()
    last_ranked = {row[0]: row[1] for row in ranked_rows}

    groups: dict[str, CarModelGroup] = {}
    for key, variant in zip((row[1] for row in rows), variants, strict=True):
        group = groups.get(key)
        if group is None:
            stat = aggregates.get(key)
            group = CarModelGroup(
                key=key,
                # Sin ofertas activas no hay agregado del que sacar la grafía
                # más frecuente; se cae a la de la primera versión.
                make=stat.make if stat else variant.make,
                model=stat.model if stat else variant.model,
                active_offers=stat.count if stat else 0,
                min_price=stat.min_price if stat else None,
                median_price=stat.median_price if stat else None,
                max_price=stat.max_price if stat else None,
                dealers_count=stat.dealers_count if stat else 0,
                last_ranked_at=last_ranked.get(key),
            )
            groups[key] = group
        group.variants.append(variant)

    for group in groups.values():
        tracked = [v.tracking for v in group.variants if v.tracking is not None]
        group.tracked_variants = len(tracked)
        targets = [t.target_price for t in tracked if t.target_price is not None]
        group.target_price = min(targets) if targets else None

        references = sorted(
            v.reference_price for v in group.variants if v.reference_price is not None
        )
        group.reference_variants = len(references)
        group.reference_price = _median(references)

    return list(groups.values())


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
