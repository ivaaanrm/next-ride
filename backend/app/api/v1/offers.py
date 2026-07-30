"""Endpoints de ofertas: lectura con métricas, ingesta y descarte manual."""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import Select, func, select
from sqlalchemy.orm import selectinload

from app.api.deps import CurrentUser, IngestDep, SessionDep
from app.models import (
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
    OfferBulkIngest,
    OfferDismiss,
    OfferIngest,
    OfferPricePoint,
    OfferRankSummary,
    OfferRead,
)
from app.services.metrics import enrich_offers
from app.services.offers import favorite_offer_ids, ingest_offers, upsert_offer

router = APIRouter(prefix="/offers", tags=["offers"])

SortField = Literal[
    "price",
    "-price",
    "value_score",
    "ai_score",
    "mileage_km",
    "-year",
    "-last_seen_at",
    "-first_seen_at",
]

# Ordenar por puntuación exige calcular métricas en Python, así que se acota
# cuántas filas se traen antes de ordenar y paginar.
_SCORE_SORT_CAP = 500
_DB_SORTS = {
    "price": Offer.price.asc(),
    "-price": Offer.price.desc(),
    "mileage_km": Offer.mileage_km.asc().nullslast(),
    "-year": Offer.year.desc().nullslast(),
    "-last_seen_at": Offer.last_seen_at.desc(),
    "-first_seen_at": Offer.first_seen_at.desc(),
}


async def _latest_ai_summaries(
    session: SessionDep, offers: list[Offer]
) -> dict[int, OfferRankSummary]:
    """Último veredicto del agente por oferta (del run completado más reciente de su modelo)."""
    if not offers:
        return {}

    model_ids = list({offer.car_model_id for offer in offers})
    latest_runs = (
        await session.execute(
            select(RankingRun.car_model_id, func.max(RankingRun.id))
            .where(
                RankingRun.car_model_id.in_(model_ids),
                RankingRun.status == RunStatus.COMPLETED,
            )
            .group_by(RankingRun.car_model_id)
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


def _apply_filters(
    stmt: Select,
    *,
    user_id: int,
    status_filter: OfferStatus | None,
    car_model_id: int | None,
    dealer_id: int | None,
    condition: VehicleCondition | None,
    fuel_type: FuelType | None,
    min_price: float | None,
    max_price: float | None,
    max_mileage_km: int | None,
    min_year: int | None,
    q: str | None,
    tracked_only: bool,
    favorites_only: bool,
) -> Select:
    stmt = stmt.where(Offer.status == (status_filter or OfferStatus.ACTIVE))
    if car_model_id:
        stmt = stmt.where(Offer.car_model_id == car_model_id)
    if dealer_id:
        stmt = stmt.where(Offer.dealer_id == dealer_id)
    if condition:
        stmt = stmt.where(Offer.condition == condition)
    if fuel_type:
        stmt = stmt.where(Offer.fuel_type == fuel_type)
    if min_price is not None:
        stmt = stmt.where(Offer.price >= min_price)
    if max_price is not None:
        stmt = stmt.where(Offer.price <= max_price)
    if max_mileage_km is not None:
        stmt = stmt.where(Offer.mileage_km <= max_mileage_km)
    if min_year is not None:
        stmt = stmt.where(Offer.year >= min_year)
    if q:
        stmt = stmt.where(func.lower(Offer.title).like(f"%{q.lower()}%"))
    if tracked_only:
        stmt = stmt.join(
            TrackedModel,
            (TrackedModel.car_model_id == Offer.car_model_id)
            & (TrackedModel.user_id == user_id)
            & (TrackedModel.is_active.is_(True)),
        )
    if favorites_only:
        stmt = stmt.join(
            OfferFavorite,
            (OfferFavorite.offer_id == Offer.id) & (OfferFavorite.user_id == user_id),
        )
    return stmt


@router.get("", response_model=Page[OfferRead])
async def list_offers(
    session: SessionDep,
    user: CurrentUser,
    status_filter: Annotated[OfferStatus | None, Query(alias="status")] = None,
    car_model_id: Annotated[int | None, Query()] = None,
    dealer_id: Annotated[int | None, Query()] = None,
    condition: Annotated[VehicleCondition | None, Query()] = None,
    fuel_type: Annotated[FuelType | None, Query()] = None,
    min_price: Annotated[float | None, Query(ge=0)] = None,
    max_price: Annotated[float | None, Query(ge=0)] = None,
    max_mileage_km: Annotated[int | None, Query(ge=0)] = None,
    min_year: Annotated[int | None, Query(ge=1950)] = None,
    q: Annotated[str | None, Query(description="Busca en el título")] = None,
    tracked_only: Annotated[bool, Query(description="Solo modelos seguidos")] = False,
    favorites_only: Annotated[bool, Query(description="Solo mis favoritos")] = False,
    sort: Annotated[SortField, Query()] = "value_score",
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Page[OfferRead]:
    filters = {
        "user_id": user.id,
        "status_filter": status_filter,
        "car_model_id": car_model_id,
        "dealer_id": dealer_id,
        "condition": condition,
        "fuel_type": fuel_type,
        "min_price": min_price,
        "max_price": max_price,
        "max_mileage_km": max_mileage_km,
        "min_year": min_year,
        "q": q,
        "tracked_only": tracked_only,
        "favorites_only": favorites_only,
    }

    total = await session.scalar(
        _apply_filters(select(func.count(Offer.id)), **filters)
    )
    total = total or 0

    if sort in _DB_SORTS:
        stmt = (
            _apply_filters(select(Offer), **filters)
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
        _apply_filters(select(Offer), **filters)
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


@router.get("/{offer_id}", response_model=OfferRead)
async def get_offer(session: SessionDep, user: CurrentUser, offer_id: int) -> OfferRead:
    offer = await _get_offer_or_404(session, offer_id)
    return (await _serialize(session, [offer], user.id))[0]


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
# Descarte manual
# --------------------------------------------------------------------------- #
@router.delete("/{offer_id}", response_model=OfferRead)
async def dismiss_offer(
    session: SessionDep,
    user: CurrentUser,
    offer_id: int,
    payload: OfferDismiss | None = None,
) -> OfferRead:
    """Descarta una oferta de la lista. Es un borrado lógico: el scraper no la revive."""
    offer = await _get_offer_or_404(session, offer_id)
    offer.status = OfferStatus.DISMISSED
    offer.dismissed_at = utcnow()
    offer.dismissed_by_id = user.id
    offer.dismiss_reason = payload.reason if payload else None
    await session.commit()
    await session.refresh(offer)
    return (await _serialize(session, [offer], user.id))[0]


@router.post("/{offer_id}/restore", response_model=OfferRead)
async def restore_offer(session: SessionDep, user: CurrentUser, offer_id: int) -> OfferRead:
    offer = await _get_offer_or_404(session, offer_id)
    offer.status = OfferStatus.ACTIVE
    offer.dismissed_at = None
    offer.dismissed_by_id = None
    offer.dismiss_reason = None
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
