"""Métricas derivadas de las ofertas.

Se calculan al leer (no se persisten) para que sigan siendo correctas cuando
entran ofertas nuevas y la mediana del modelo se mueve.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from datetime import UTC, datetime

from sqlalchemy import Float, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from app.models import CarModel, Offer, OfferPriceHistory, OfferStatus, VehicleCondition
from app.schemas.offer import MakeModelPriceStats, ModelPriceStats, OfferMetrics, PriceStats
from app.schemas.scoring import ScoreParams
from app.services.scoring import (
    DEFAULT_CONFIG,
    ScoringConfig,
    expected_price,
    get_scoring_config,
    market_new_price,
    score_offer,
)


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


def make_model_key() -> ColumnElement[str]:
    """`marca|modelo` en minúsculas: la clave del binomio.

    Es la misma que usa `/analytics/segments`, y se calcula en SQL siempre que se
    pueda. Dos minúsculas distintas —las de Postgres y las de `str.lower`— dejarían
    a un binomio sin sus agregados o sin sus ofertas.
    """
    return func.lower(CarModel.make) + "|" + func.lower(CarModel.model)


async def make_model_price_stats(
    session: AsyncSession, car_model_ids: Sequence[int]
) -> dict[str, MakeModelPriceStats]:
    """Los mismos agregados, pero por binomio marca-modelo.

    Hace falta su propia consulta: componer el binomio a partir de
    `model_price_stats` daría una mediana de medianas y contaría dos veces al
    dealer que tiene dos versiones.
    """
    if not car_model_ids:
        return {}

    key = make_model_key()
    median = func.percentile_cont(0.5).within_group(cast(Offer.price, Float))
    stmt = (
        select(
            key,
            # `mode()` y no `min()`: la etiqueta es la grafía más frecuente, no
            # la que gane alfabéticamente («A4 Allroad Quattro» y «A4 Allroad
            # quattro» son el mismo binomio escrito de dos maneras).
            func.mode().within_group(CarModel.make),
            func.mode().within_group(CarModel.model),
            func.count(Offer.id),
            func.min(cast(Offer.price, Float)),
            median,
            func.max(cast(Offer.price, Float)),
            func.avg(cast(Offer.price, Float)),
            func.avg(cast(Offer.mileage_km, Float)),
            func.avg(cast(Offer.year, Float)),
            func.count(func.distinct(Offer.dealer_id)),
            func.count(func.distinct(Offer.car_model_id)),
        )
        .select_from(Offer)
        .join(CarModel, CarModel.id == Offer.car_model_id)
        .where(Offer.car_model_id.in_(car_model_ids), Offer.status == OfferStatus.ACTIVE)
        .group_by(key)
    )
    rows = (await session.execute(stmt)).all()

    return {
        row[0]: MakeModelPriceStats(
            key=row[0],
            make=row[1],
            model=row[2],
            count=row[3] or 0,
            min_price=row[4],
            median_price=round(row[5], 2) if row[5] is not None else None,
            max_price=row[6],
            avg_price=row[7],
            avg_mileage_km=row[8],
            avg_year=row[9],
            dealers_count=row[10] or 0,
            versions=row[11] or 0,
        )
        for row in rows
    }


async def binomio_scope(
    session: AsyncSession, car_model_ids: Sequence[int]
) -> tuple[dict[int, str], list[int]]:
    """La clave del binomio de cada versión, y *todas* las versiones de esos binomios.

    Hacen falta las dos cosas: la clave para saber contra qué mercado se compara
    cada oferta, y el resto de versiones porque el mercado del binomio incluye
    ofertas de acabados que no están en la página que se esté mirando.
    """
    if not car_model_ids:
        return {}, []

    key = make_model_key()
    keys_of = {
        row[0]: row[1]
        for row in (
            await session.execute(
                select(CarModel.id, key).where(CarModel.id.in_(car_model_ids))
            )
        ).all()
    }
    siblings = list(
        await session.scalars(select(CarModel.id).where(key.in_(set(keys_of.values()))))
    )
    return keys_of, siblings


async def market_new_prices(
    session: AsyncSession, car_model_ids: Sequence[int], params: ScoreParams
) -> dict[str, float]:
    """PVP estimado por binomio, invirtiendo la curva de depreciación.

    La consulta trae lo mínimo (precio, año, estado) de las ofertas activas y la
    mediana de los precios de nuevo implícitos se calcula en Python, que es
    donde vive la curva. Es el ancla de reserva del valor esperado para los
    modelos sin `reference_price` curado, es decir, casi todo lo scrapeado.
    """
    if not car_model_ids:
        return {}

    key = make_model_key()
    rows = (
        await session.execute(
            select(key, cast(Offer.price, Float), Offer.year, Offer.condition)
            .select_from(Offer)
            .join(CarModel, CarModel.id == Offer.car_model_id)
            .where(Offer.car_model_id.in_(car_model_ids), Offer.status == OfferStatus.ACTIVE)
        )
    ).all()

    by_key: dict[str, list[tuple[float, int | None, VehicleCondition]]] = {}
    for binomio, price, year, condition in rows:
        by_key.setdefault(binomio, []).append((price, year, condition))

    now_year = datetime.now(UTC).year
    anchors = {
        binomio: anchor
        for binomio, offers in by_key.items()
        if (anchor := market_new_price(offers, params, now_year)) is not None
    }
    return anchors


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


def compute_metrics(
    offer: Offer,
    stats: PriceStats | None,
    initial_price: float | None = None,
    config: ScoringConfig | None = None,
    market_new_price: float | None = None,
) -> OfferMetrics:
    """Las métricas de una oferta contra el mercado que le pasen.

    `config` son los pesos y parámetros vigentes de la puntuación; sin él rigen
    los defaults (rutas que no tocan BD, como los scripts de humo).
    `market_new_price` es el PVP estimado del binomio, el ancla de reserva del
    valor esperado cuando la versión no tiene `reference_price` curado.
    """
    config = config or DEFAULT_CONFIG
    price = float(offer.price)
    now = datetime.now(UTC)
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
        metrics.days_listed = max((now - first_seen).days, 0)

    if offer.mileage_km is not None and offer.year:
        age = max(now.year - offer.year, 1)
        metrics.km_per_year = round(offer.mileage_km / age, 1)

    # Valor esperado por depreciación media (edad + km). El ancla preferente es
    # el PVP curado de la versión; sin él, el estimado del mercado del binomio.
    curated = reference if reference and float(reference) > 0 else None
    anchor = float(curated) if curated else market_new_price
    expected = expected_price(offer, anchor, config.params, now.year)
    if expected and expected > 0:
        metrics.expected_price_eur = expected
        metrics.price_vs_expected_pct = round((price - expected) / expected * 100, 2)
        metrics.expected_price_source = "pvp" if curated else "mercado"

    metrics.value_score, metrics.score_breakdown = score_offer(
        offer, stats, metrics, initial_price, config, now
    )
    return metrics


async def enrich_offers(
    session: AsyncSession, offers: Iterable[Offer]
) -> tuple[list[Offer], dict[int, OfferMetrics]]:
    """Devuelve las ofertas junto a sus métricas, indexadas por `offer.id`.

    El mercado contra el que se mide una oferta es su **binomio marca-modelo**, no
    su fila de `car_models`. El catálogo está partido por acabado y la mayoría de
    versiones tienen una sola oferta: su mediana sería el propio precio del coche,
    así que `price_vs_median_pct` salía 0,0 % —«justo en mercado»— comparándolo
    consigo mismo, y `value_score` se quedaba clavado en la mitad de la escala.
    Es además la mediana con la que rankea el agente de IA, así que las cifras del
    panel de ranking y las suyas dicen ahora lo mismo.
    """
    offer_list = list(offers)
    if not offer_list:
        return [], {}

    keys_of, siblings = await binomio_scope(
        session, list({offer.car_model_id for offer in offer_list})
    )
    stats = await make_model_price_stats(session, siblings)
    initial_prices = await first_seen_prices(session, [offer.id for offer in offer_list])
    config = await get_scoring_config(session)
    anchors = await market_new_prices(session, siblings, config.params)

    metrics = {
        offer.id: compute_metrics(
            offer,
            stats.get(keys_of.get(offer.car_model_id, "")),
            initial_prices.get(offer.id),
            config,
            anchors.get(keys_of.get(offer.car_model_id, "")),
        )
        for offer in offer_list
    }
    return offer_list, metrics
