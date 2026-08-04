"""Endpoints de ofertas: lectura con métricas, ingesta y descarte manual."""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import Float, Select, case, cast, func, select
from sqlalchemy.orm import selectinload

from app.api.deps import CurrentUser, IngestDep, SessionDep
from app.core.config import settings
from app.models import (
    CarModel,
    Dealer,
    FuelType,
    Offer,
    OfferFavorite,
    OfferRanking,
    OfferStatus,
    RankingRun,
    RunStatus,
    TrackedModel,
    VehicleCondition,
    utcnow,
)
from app.schemas.common import Page
from app.schemas.offer import (
    IngestResult,
    OfferAggregateStats,
    OfferBulkIngest,
    OfferDismiss,
    OfferIngest,
    OfferPricePoint,
    OfferRankSummary,
    OfferRatingUpdate,
    OfferRawRead,
    OfferRead,
    OfferUpdate,
)
from app.services.metrics import enrich_offers, make_model_key
from app.services.offers import (
    apply_manual_edit,
    favorite_offer_ids,
    ingest_offers,
    upsert_offer,
)

router = APIRouter(prefix="/offers", tags=["offers"])

# El prefijo `-` es descendente. Las columnas de la tabla ordenan en los dos
# sentidos, así que cada campo viaja en pareja; las dos puntuaciones son la
# excepción y solo se sirven de mejor a peor, porque «los peores chollos
# primero» no es una pregunta que nadie haga.
SortField = Literal[
    "price",
    "-price",
    "year",
    "-year",
    "mileage_km",
    "-mileage_km",
    "first_seen_at",
    "-first_seen_at",
    "-last_seen_at",
    "value_score",
    "ai_score",
]

# Ordenar por puntuación exige calcular métricas en Python, así que se acota
# cuántas filas se traen antes de ordenar y paginar.
_SCORE_SORT_CAP = 500
# `nullslast()` en los dos sentidos y no solo en el descendente: un año o unos
# kilómetros que el scraper no trajo no son «el más antiguo» ni «el que menos
# ha rodado», así que no deben encabezar el orden ascendente.
_DB_SORTS = {
    "price": Offer.price.asc(),
    "-price": Offer.price.desc(),
    "year": Offer.year.asc().nullslast(),
    "-year": Offer.year.desc().nullslast(),
    "mileage_km": Offer.mileage_km.asc().nullslast(),
    "-mileage_km": Offer.mileage_km.desc().nullslast(),
    "first_seen_at": Offer.first_seen_at.asc(),
    "-first_seen_at": Offer.first_seen_at.desc(),
    "-last_seen_at": Offer.last_seen_at.desc(),
}


async def _latest_ai_summaries(
    session: SessionDep, offers: list[Offer]
) -> dict[int, OfferRankSummary]:
    """Último veredicto del agente por oferta (del run completado más reciente de su modelo).

    El run es del binomio marca-modelo, así que la oferta se une por su binomio y
    no por su `car_model_id`: dos versiones del mismo modelo comparten ranking.
    """
    if not offers:
        return {}

    # La clave se pide a SQL, que es quien la escribió en `ranking_runs`:
    # componerla aquí con `str.lower` metería otras minúsculas en la comparación.
    keys = list(
        await session.scalars(
            select(make_model_key())
            .where(CarModel.id.in_({offer.car_model_id for offer in offers}))
            .distinct()
        )
    )
    latest_runs = (
        await session.execute(
            select(RankingRun.make_model_key, func.max(RankingRun.id))
            .where(
                RankingRun.make_model_key.in_(keys),
                RankingRun.status == RunStatus.COMPLETED,
            )
            .group_by(RankingRun.make_model_key)
        )
    ).all()
    run_ids = [row[1] for row in latest_runs]
    if not run_ids:
        return {}

    rows = (
        await session.execute(
            select(OfferRanking, RankingRun.created_at)
            .join(RankingRun, RankingRun.id == OfferRanking.run_id)
            .where(
                OfferRanking.run_id.in_(run_ids),
                OfferRanking.offer_id.in_([offer.id for offer in offers]),
            )
        )
    ).unique().all()

    return {
        item.offer_id: OfferRankSummary(
            rank=item.rank,
            score=item.score,
            verdict=item.verdict.value,
            reasoning=item.reasoning,
            run_id=item.run_id,
            ranked_at=created_at,
        )
        for item, created_at in rows
    }


async def _serialize(
    session: SessionDep, offers: list[Offer], user_id: int | None
) -> list[OfferRead]:
    offers, metrics = await enrich_offers(session, offers)
    ai = await _latest_ai_summaries(session, offers)
    favorites = await favorite_offer_ids(session, user_id, [offer.id for offer in offers])

    result = []
    for offer in offers:
        item = OfferRead.model_validate(offer)
        item.metrics = metrics[offer.id]
        item.ai = ai.get(offer.id)
        item.is_favorite = offer.id in favorites
        result.append(item)
    return result


async def _get_offer_or_404(session: SessionDep, offer_id: int) -> Offer:
    offer = await session.get(Offer, offer_id)
    if offer is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Oferta no encontrada")
    return offer


@dataclass
class OfferFilters:
    """Filtros del listado, en una dependencia compartida.

    Están aquí y no repetidos en cada endpoint para que `GET /offers` y
    `GET /offers/stats` no puedan divergir: si divergieran, las métricas de
    cabecera describirían un conjunto distinto del que enseña la tabla, que es
    exactamente el error que hace inútil una métrica.
    """

    status_filter: Annotated[OfferStatus | None, Query(alias="status")] = None
    car_model_id: Annotated[int | None, Query()] = None
    dealer_id: Annotated[int | None, Query()] = None
    condition: Annotated[VehicleCondition | None, Query()] = None
    fuel_type: Annotated[FuelType | None, Query()] = None
    min_price: Annotated[float | None, Query(ge=0)] = None
    max_price: Annotated[float | None, Query(ge=0)] = None
    max_mileage_km: Annotated[int | None, Query(ge=0)] = None
    min_year: Annotated[int | None, Query(ge=1950)] = None
    max_year: Annotated[int | None, Query(ge=1950)] = None
    q: Annotated[str | None, Query(description="Busca en el título")] = None
    tracked_only: Annotated[bool, Query(description="Solo modelos seguidos")] = False
    favorites_only: Annotated[bool, Query(description="Solo mis favoritos")] = False


FiltersDep = Annotated[OfferFilters, Depends()]


def _apply_filters(stmt: Select, filters: OfferFilters, user_id: int) -> Select:
    stmt = stmt.where(Offer.status == (filters.status_filter or OfferStatus.ACTIVE))
    if filters.car_model_id:
        stmt = stmt.where(Offer.car_model_id == filters.car_model_id)
    if filters.dealer_id:
        stmt = stmt.where(Offer.dealer_id == filters.dealer_id)
    if filters.condition:
        stmt = stmt.where(Offer.condition == filters.condition)
    if filters.fuel_type:
        stmt = stmt.where(Offer.fuel_type == filters.fuel_type)
    if filters.min_price is not None:
        stmt = stmt.where(Offer.price >= filters.min_price)
    if filters.max_price is not None:
        stmt = stmt.where(Offer.price <= filters.max_price)
    if filters.max_mileage_km is not None:
        stmt = stmt.where(Offer.mileage_km <= filters.max_mileage_km)
    if filters.min_year is not None:
        stmt = stmt.where(Offer.year >= filters.min_year)
    if filters.max_year is not None:
        stmt = stmt.where(Offer.year <= filters.max_year)
    if filters.q:
        stmt = stmt.where(func.lower(Offer.title).like(f"%{filters.q.lower()}%"))
    if filters.tracked_only:
        stmt = stmt.join(
            TrackedModel,
            (TrackedModel.car_model_id == Offer.car_model_id)
            & (TrackedModel.user_id == user_id)
            & (TrackedModel.is_active.is_(True)),
        )
    if filters.favorites_only:
        stmt = stmt.join(
            OfferFavorite,
            (OfferFavorite.offer_id == Offer.id) & (OfferFavorite.user_id == user_id),
        )
    return stmt


@router.get("", response_model=Page[OfferRead])
async def list_offers(
    session: SessionDep,
    user: CurrentUser,
    filters: FiltersDep,
    sort: Annotated[SortField, Query()] = "value_score",
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Page[OfferRead]:
    total = await session.scalar(
        _apply_filters(select(func.count(Offer.id)), filters, user.id)
    )
    total = total or 0

    if sort in _DB_SORTS:
        stmt = (
            _apply_filters(select(Offer), filters, user.id)
            .order_by(_DB_SORTS[sort], Offer.id)
            .limit(limit)
            .offset(offset)
        )
        offers = list((await session.scalars(stmt)).unique())
        return Page(
            items=await _serialize(session, offers, user.id),
            total=total,
            limit=limit,
            offset=offset,
        )

    # Ordenación por puntuación: se calcula en Python sobre un conjunto acotado.
    stmt = (
        _apply_filters(select(Offer), filters, user.id)
        .order_by(Offer.price.asc(), Offer.id)
        .limit(_SCORE_SORT_CAP)
    )
    offers = list((await session.scalars(stmt)).unique())
    serialized = await _serialize(session, offers, user.id)

    if sort == "ai_score":
        serialized.sort(
            key=lambda o: (
                o.ai is None,
                -(o.ai.score if o.ai else 0),
                -(o.metrics.value_score or 0),
            )
        )
    else:
        serialized.sort(key=lambda o: -(o.metrics.value_score or 0))

    return Page(
        items=serialized[offset : offset + limit],
        total=min(total, _SCORE_SORT_CAP) if total > _SCORE_SORT_CAP else total,
        limit=limit,
        offset=offset,
    )


# Antes de `/{offer_id}`: si no, FastAPI intenta leer "stats" como int y da 422.
@router.get("/stats", response_model=OfferAggregateStats)
async def offer_stats(
    session: SessionDep, user: CurrentUser, filters: FiltersDep
) -> OfferAggregateStats:
    """Agregados sobre las filas que cumplen el filtro, no sobre todo el catálogo."""
    discount = case(
        (
            (Offer.original_price.isnot(None)) & (Offer.original_price > 0),
            (cast(Offer.original_price, Float) - cast(Offer.price, Float))
            / cast(Offer.original_price, Float)
            * 100,
        ),
        else_=None,
    )
    # Mismo cálculo que `compute_metrics`: km entre la edad del coche, con la
    # edad a un mínimo de 1 para no dividir por cero en un año en curso.
    now_year = datetime.now(UTC).year
    km_per_year = case(
        (
            (Offer.mileage_km.isnot(None)) & (Offer.year.isnot(None)),
            cast(Offer.mileage_km, Float)
            / func.greatest(cast(now_year - Offer.year, Float), 1.0),
        ),
        else_=None,
    )

    row = (
        await session.execute(
            _apply_filters(
                select(
                    func.count(Offer.id),
                    func.count(func.distinct(Offer.car_model_id)),
                    func.avg(cast(Offer.price, Float)),
                    func.avg(cast(Offer.mileage_km, Float)),
                    func.avg(km_per_year),
                    func.avg(discount),
                ),
                filters,
                user.id,
            )
        )
    ).one()

    def _round(value: float | None, digits: int = 2) -> float | None:
        return round(value, digits) if value is not None else None

    # Extremos para los controles de rango del frontend. Cada uno se calcula con
    # su propio filtro quitado a propósito: son el dominio del deslizador, no un
    # agregado de lo que se ve. Con el filtro aplicado, el carril se encogería a
    # la selección en cada arrastre y quedaría sin salida. Los demás filtros sí
    # cuentan, y por eso son dos consultas y no una: acotar el precio sí debe
    # recortar el carril de los años, y al revés.
    price_floor, price_ceiling = (
        await session.execute(
            _apply_filters(
                select(func.min(Offer.price), func.max(Offer.price)),
                replace(filters, min_price=None, max_price=None),
                user.id,
            )
        )
    ).one()
    # `Offer.year` admite nulos y `MIN`/`MAX` los ignoran: una oferta sin año no
    # estira el carril, solo desaparece al tocarlo, que es lo correcto.
    year_floor, year_ceiling = (
        await session.execute(
            _apply_filters(
                select(func.min(Offer.year), func.max(Offer.year)),
                replace(filters, min_year=None, max_year=None),
                user.id,
            )
        )
    ).one()

    # El mejor chollo sí exige puntuar en Python, así que se acota igual que el
    # orden por puntuación del listado: así ambos coinciden en la fila de arriba.
    best_deal = None
    candidates = list(
        (
            await session.scalars(
                _apply_filters(select(Offer), filters, user.id)
                .order_by(Offer.price.asc(), Offer.id)
                .limit(_SCORE_SORT_CAP)
            )
        ).unique()
    )
    if candidates:
        offers, metrics = await enrich_offers(session, candidates)
        top = max(offers, key=lambda offer: metrics[offer.id].value_score or 0)
        best_deal = (await _serialize(session, [top], user.id))[0]

    return OfferAggregateStats(
        count=row[0] or 0,
        car_models=row[1] or 0,
        avg_price=_round(row[2]),
        avg_mileage_km=_round(row[3], 0),
        avg_km_per_year=_round(row[4], 0),
        avg_discount_pct=_round(row[5]),
        best_deal=best_deal,
        ai_enabled=settings.ai_enabled,
        price_floor=_round(price_floor),
        price_ceiling=_round(price_ceiling),
        year_floor=year_floor,
        year_ceiling=year_ceiling,
    )


@router.get("/{offer_id}", response_model=OfferRead)
async def get_offer(session: SessionDep, user: CurrentUser, offer_id: int) -> OfferRead:
    offer = await _get_offer_or_404(session, offer_id)
    return (await _serialize(session, [offer], user.id))[0]


@router.get("/{offer_id}/raw", response_model=OfferRawRead)
async def get_offer_raw(session: SessionDep, _: CurrentUser, offer_id: int) -> OfferRawRead:
    """Payload crudo del scraper. Se pide aparte: no va en el listado."""
    offer = await _get_offer_or_404(session, offer_id)
    return OfferRawRead(raw=offer.raw)


@router.get("/{offer_id}/price-history", response_model=list[OfferPricePoint])
async def get_price_history(
    session: SessionDep, _: CurrentUser, offer_id: int
) -> list[OfferPricePoint]:
    offer = await session.get(Offer, offer_id, options=[selectinload(Offer.price_history)])
    if offer is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Oferta no encontrada")
    return [OfferPricePoint.model_validate(point) for point in offer.price_history]


# --------------------------------------------------------------------------- #
# Ingesta — la consume el servicio scraper (JWT o X-API-Key)
# --------------------------------------------------------------------------- #
@router.post("", response_model=OfferRead, status_code=status.HTTP_201_CREATED)
async def create_offer(
    session: SessionDep, principal: IngestDep, payload: OfferIngest
) -> OfferRead:
    """Registra una oferta encontrada. Si la URL ya existe, la actualiza."""
    offer, _created = await upsert_offer(session, payload)
    await session.commit()
    await session.refresh(offer)
    user_id = principal.user.id if principal.user else None
    return (await _serialize(session, [offer], user_id))[0]


@router.post("/bulk", response_model=IngestResult)
async def create_offers_bulk(
    session: SessionDep, principal: IngestDep, payload: OfferBulkIngest
) -> IngestResult:
    """Ingesta en lote. Las ofertas con error se reportan sin abortar el resto."""
    return await ingest_offers(session, payload.offers)


# --------------------------------------------------------------------------- #
# Corrección manual
#
# El scraper acierta casi siempre y falla en lo de siempre: el año que viene en
# el título y no en la ficha, los kilómetros con un punto de más, la versión mal
# resuelta. Esto es la salida para eso, y no un CRUD de ofertas: solo se tocan
# las columnas de `EDITABLE_FIELDS`, y cada una que se toca queda anclada para
# que el siguiente pase del scraper no la deshaga (ver `apply_manual_edit`).
# --------------------------------------------------------------------------- #
@router.patch("/{offer_id}", response_model=OfferRead)
async def update_offer(
    session: SessionDep, user: CurrentUser, offer_id: int, payload: OfferUpdate
) -> OfferRead:
    """Corrige o completa a mano los datos de una oferta.

    Solo se escriben los campos presentes en el cuerpo: mandar `year: null`
    borra el año, no mandarlo lo deja como está. Es la diferencia entre corregir
    y arrasar, y por eso el formulario del frontend manda únicamente el diff.
    """
    offer = await _get_offer_or_404(session, offer_id)

    # Reatribuir a otra versión o a otro dealer se comprueba antes de escribir:
    # el error de la restricción de clave ajena sería un 500 con un mensaje de
    # Postgres dentro, y esto es un 404 con el nombre de lo que no existe.
    if (
        payload.car_model_id is not None
        and payload.car_model_id != offer.car_model_id
        and await session.get(CarModel, payload.car_model_id) is None
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Modelo no encontrado")
    if (
        payload.dealer_id is not None
        and payload.dealer_id != offer.dealer_id
        and await session.get(Dealer, payload.dealer_id) is None
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dealer no encontrado")

    await apply_manual_edit(session, offer, payload, user.id)
    await session.commit()
    await session.refresh(offer)
    return (await _serialize(session, [offer], user.id))[0]


# --------------------------------------------------------------------------- #
# Estado de la oferta — las tres transiciones que se hacen a mano
#
# Comparten cuerpo porque son la misma escritura con otro destino, y las columnas
# `dismissed_*` registran lo mismo en los dos casos: cuándo salió de la lista
# activa y a instancias de quién.
#
# La diferencia entre los dos estados de salida no es de matiz y la aplica el
# scraper, no esto (ver `upsert_offer`): al volver a ver la oferta revive una
# EXPIRED —el anuncio había desaparecido y ha vuelto— y respeta una DISMISSED,
# porque esa es una decisión de una persona y no un hecho del origen.
# --------------------------------------------------------------------------- #
async def _move_to(
    session: SessionDep,
    user: CurrentUser,
    offer_id: int,
    target: OfferStatus,
    reason: str | None = None,
) -> OfferRead:
    offer = await _get_offer_or_404(session, offer_id)
    back_to_active = target is OfferStatus.ACTIVE
    offer.status = target
    offer.dismissed_at = None if back_to_active else utcnow()
    offer.dismissed_by_id = None if back_to_active else user.id
    offer.dismiss_reason = None if back_to_active else reason
    await session.commit()
    await session.refresh(offer)
    return (await _serialize(session, [offer], user.id))[0]


@router.delete("/{offer_id}", response_model=OfferRead)
async def dismiss_offer(
    session: SessionDep,
    user: CurrentUser,
    offer_id: int,
    payload: OfferDismiss | None = None,
) -> OfferRead:
    """Descarta una oferta de la lista. Es un borrado lógico: el scraper no la revive."""
    return await _move_to(
        session, user, offer_id, OfferStatus.DISMISSED, payload.reason if payload else None
    )


@router.post("/{offer_id}/expire", response_model=OfferRead)
async def expire_offer(
    session: SessionDep,
    user: CurrentUser,
    offer_id: int,
    payload: OfferDismiss | None = None,
) -> OfferRead:
    """Marca la oferta como ya no disponible en el origen.

    Es la misma marca que pone el scraper cuando el anuncio desaparece, puesta a
    mano por quien ha abierto el enlace y se ha encontrado con que el coche ya no
    está. No es un descarte: aquí nadie ha dicho que la oferta no interese, solo
    que ya no existe, y por eso el scraper puede revivirla si vuelve a verla.
    """
    return await _move_to(
        session, user, offer_id, OfferStatus.EXPIRED, payload.reason if payload else None
    )


@router.post("/{offer_id}/restore", response_model=OfferRead)
async def restore_offer(session: SessionDep, user: CurrentUser, offer_id: int) -> OfferRead:
    """Devuelve la oferta a la lista activa, venga de un descarte o de una expiración."""
    return await _move_to(session, user, offer_id, OfferStatus.ACTIVE)


# --------------------------------------------------------------------------- #
# Valoración manual — las dos señales que no están en el anuncio
#
# Endpoint propio y no un campo más de `PATCH /offers/{id}`: aquello corrige
# datos del origen y por eso ancla cada campo que toca contra el scraper. Estas
# notas no las trae ningún origen, así que no hay nada contra lo que anclarlas, y
# meterlas en `manual_fields` habría hecho que valorar un coche se contara como
# «corregido a mano» en su procedencia, que es justo lo contrario de lo que pasó.
# --------------------------------------------------------------------------- #
@router.put("/{offer_id}/rating", response_model=OfferRead)
async def rate_offer(
    session: SessionDep, user: CurrentUser, offer_id: int, payload: OfferRatingUpdate
) -> OfferRead:
    """Pone o quita las notas de equipamiento y estado aparente (1-5 ★).

    Solo se escriben las que vienen en el cuerpo: mandar una deja la otra como
    estaba, y mandarla a `null` la borra —lo que devuelve la señal a «sin dato»
    y reparte su peso, en vez de dejarla puntuando 0—.
    """
    offer = await _get_offer_or_404(session, offer_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(offer, field, value)
    await session.commit()
    await session.refresh(offer)
    return (await _serialize(session, [offer], user.id))[0]


# --------------------------------------------------------------------------- #
# Favoritos — marca personal de cada usuario
# --------------------------------------------------------------------------- #
@router.post("/{offer_id}/favorite", response_model=OfferRead)
async def add_favorite(session: SessionDep, user: CurrentUser, offer_id: int) -> OfferRead:
    """Marca la oferta como favorita. Es idempotente: marcarla dos veces no falla."""
    offer = await _get_offer_or_404(session, offer_id)

    existing = await session.scalar(
        select(OfferFavorite).where(
            OfferFavorite.user_id == user.id, OfferFavorite.offer_id == offer_id
        )
    )
    if existing is None:
        session.add(OfferFavorite(user_id=user.id, offer_id=offer_id))
        await session.commit()

    return (await _serialize(session, [offer], user.id))[0]


@router.delete("/{offer_id}/favorite", response_model=OfferRead)
async def remove_favorite(session: SessionDep, user: CurrentUser, offer_id: int) -> OfferRead:
    """Quita la marca de favorito. También idempotente."""
    offer = await _get_offer_or_404(session, offer_id)

    existing = await session.scalar(
        select(OfferFavorite).where(
            OfferFavorite.user_id == user.id, OfferFavorite.offer_id == offer_id
        )
    )
    if existing is not None:
        await session.delete(existing)
        await session.commit()

    return (await _serialize(session, [offer], user.id))[0]
