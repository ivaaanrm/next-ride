"""Métricas derivadas de las ofertas.

Se calculan al leer (no se persisten) para que sigan siendo correctas cuando
entran ofertas nuevas y la mediana del modelo se mueve.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from datetime import UTC, datetime

from sqlalchemy import Float, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Offer, OfferPriceHistory, OfferStatus
from app.schemas.offer import ModelPriceStats, OfferMetrics


async def model_price_stats(
    session: AsyncSession, car_model_ids: Sequence[int]
) -> dict[int, ModelPriceStats]:
    """Agregados de precio por modelo, sobre ofertas activas."""
    if not car_model_ids:
        return {}

    median = func.percentile_cont(0.5).within_group(cast(Offer.price, Float))
    stmt = (
        select(
            Offer.car_model_id,
            func.count(Offer.id),
            func.min(cast(Offer.price, Float)),
            median,
            func.max(cast(Offer.price, Float)),
            func.avg(cast(Offer.price, Float)),
            func.avg(cast(Offer.mileage_km, Float)),
            func.avg(cast(Offer.year, Float)),
            func.count(func.distinct(Offer.dealer_id)),
        )
        .where(Offer.car_model_id.in_(car_model_ids), Offer.status == OfferStatus.ACTIVE)
        .group_by(Offer.car_model_id)
    )
    rows = (await session.execute(stmt)).all()

    stats = {
        row[0]: ModelPriceStats(
            car_model_id=row[0],
            count=row[1] or 0,
            min_price=row[2],
            median_price=row[3],
            max_price=row[4],
            avg_price=row[5],
            avg_mileage_km=row[6],
            avg_year=row[7],
            dealers_count=row[8] or 0,
        )
        for row in rows
    }
    # Modelos sin ofertas activas también deben aparecer, con contadores a cero.
    for model_id in car_model_ids:
        stats.setdefault(model_id, ModelPriceStats(car_model_id=model_id, count=0))
    return stats


async def first_seen_prices(
    session: AsyncSession, offer_ids: Sequence[int]
) -> dict[int, float]:
    """Primer precio registrado por oferta, para calcular la bajada de precio."""
    if not offer_ids:
        return {}
    subq = (
        select(
            OfferPriceHistory.offer_id,
            func.min(OfferPriceHistory.recorded_at).label("first_at"),
        )
        .where(OfferPriceHistory.offer_id.in_(offer_ids))
        .group_by(OfferPriceHistory.offer_id)
        .subquery()
    )
    stmt = select(OfferPriceHistory.offer_id, cast(OfferPriceHistory.price, Float)).join(
        subq,
        (OfferPriceHistory.offer_id == subq.c.offer_id)
        & (OfferPriceHistory.recorded_at == subq.c.first_at),
    )
    return {row[0]: row[1] for row in (await session.execute(stmt)).all()}


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def compute_metrics(
    offer: Offer,
    stats: ModelPriceStats | None,
    initial_price: float | None = None,
) -> OfferMetrics:
    price = float(offer.price)
    metrics = OfferMetrics()

    if offer.original_price and float(offer.original_price) > 0:
        original = float(offer.original_price)
        metrics.discount_pct = round((original - price) / original * 100, 2)

    if stats and stats.median_price:
        metrics.price_vs_median_pct = round(
            (price - stats.median_price) / stats.median_price * 100, 2
        )

    reference = offer.car_model.reference_price if offer.car_model else None
    if reference and float(reference) > 0:
        metrics.price_vs_reference_pct = round(
            (price - float(reference)) / float(reference) * 100, 2
        )

    if initial_price and initial_price > 0 and initial_price != price:
        metrics.price_drop_pct = round((initial_price - price) / initial_price * 100, 2)

    first_seen = offer.first_seen_at
    if first_seen is not None:
        if first_seen.tzinfo is None:
            first_seen = first_seen.replace(tzinfo=UTC)
        metrics.days_listed = max((datetime.now(UTC) - first_seen).days, 0)

    now_year = datetime.now(UTC).year
    if offer.mileage_km is not None and offer.year:
        age = max(now_year - offer.year, 1)
        metrics.km_per_year = round(offer.mileage_km / age, 1)

    metrics.value_score = _value_score(offer, stats, metrics)
    return metrics


def _value_score(
    offer: Offer, stats: ModelPriceStats | None, metrics: OfferMetrics
) -> float:
    """Heurística 0-100. Es la señal *determinista*; el agente de IA aporta la suya aparte."""
    score = 50.0

    # Un precio por debajo de la mediana del modelo es la señal más fuerte.
    if metrics.price_vs_median_pct is not None:
        score += _clamp(-metrics.price_vs_median_pct * 1.2, -28, 28)

    # Descuento anunciado sobre PVP.
    if metrics.discount_pct is not None:
        score += _clamp(metrics.discount_pct * 0.6, 0, 14)

    # Bajada de precio desde que la vimos por primera vez.
    if metrics.price_drop_pct is not None:
        score += _clamp(metrics.price_drop_pct * 0.8, 0, 8)

    # Kilometraje frente a la media del modelo.
    if stats and stats.avg_mileage_km and offer.mileage_km is not None:
        delta = (stats.avg_mileage_km - offer.mileage_km) / max(stats.avg_mileage_km, 1)
        score += _clamp(delta * 12, -10, 10)

    # Antigüedad frente a la media del modelo.
    if stats and stats.avg_year and offer.year:
        score += _clamp((offer.year - stats.avg_year) * 2.5, -8, 8)

    # Un dealer bien valorado suma un poco.
    if offer.dealer and offer.dealer.rating is not None:
        score += _clamp((offer.dealer.rating - 3.5) * 3, -5, 5)

    return round(_clamp(score, 0, 100), 1)


async def enrich_offers(
    session: AsyncSession, offers: Iterable[Offer]
) -> tuple[list[Offer], dict[int, OfferMetrics]]:
    """Devuelve las ofertas junto a sus métricas, indexadas por `offer.id`."""
    offer_list = list(offers)
    if not offer_list:
        return [], {}

    model_ids = list({offer.car_model_id for offer in offer_list})
    stats = await model_price_stats(session, model_ids)
    initial_prices = await first_seen_prices(session, [offer.id for offer in offer_list])

    metrics = {
        offer.id: compute_metrics(
            offer, stats.get(offer.car_model_id), initial_prices.get(offer.id)
        )
        for offer in offer_list
    }
    return offer_list, metrics
