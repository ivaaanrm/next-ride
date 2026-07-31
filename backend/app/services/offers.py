"""Ofertas: ingesta (upsert por URL), historial de precios y favoritos."""

from __future__ import annotations

import logging
from collections.abc import Sequence
from decimal import Decimal
from typing import Any

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Offer, OfferFavorite, OfferPriceHistory, OfferStatus, utcnow
from app.schemas.offer import IngestResult, OfferIngest
from app.services.catalog import get_or_create_car_model, get_or_create_dealer

logger = logging.getLogger(__name__)


async def favorite_offer_ids(
    session: AsyncSession, user_id: int | None, offer_ids: Sequence[int]
) -> set[int]:
    """Cuáles de estas ofertas ha marcado el usuario.

    Vacío si quien pregunta no es una persona (el scraper ingesta con API key y
    no tiene favoritos).
    """
    if user_id is None or not offer_ids:
        return set()
    rows = await session.scalars(
        select(OfferFavorite.offer_id).where(
            OfferFavorite.user_id == user_id,
            OfferFavorite.offer_id.in_(offer_ids),
        )
    )
    return set(rows)


def _summarize(exc: ValidationError) -> str:
    """Comprime un ValidationError a una línea legible para `IngestResult.errors`."""
    return "; ".join(
        f"{'.'.join(str(part) for part in error['loc'])}: {error['msg']}"
        for error in exc.errors()[:4]
    )


async def upsert_offer(session: AsyncSession, payload: OfferIngest) -> tuple[Offer, bool]:
    """Crea o actualiza una oferta. Devuelve `(oferta, se_ha_creado)`."""
    dealer = await get_or_create_dealer(
        session,
        payload.dealer_name,
        website=payload.dealer_website,
        city=payload.dealer_city,
        country=payload.dealer_country,
    )
    car_model = await get_or_create_car_model(
        session, payload.make, payload.model, payload.trim
    )

    url = str(payload.url)
    price = Decimal(str(payload.price))
    existing = await session.scalar(select(Offer).where(Offer.url == url))

    if existing is None:
        offer = Offer(
            url=url,
            external_id=payload.external_id,
            source=payload.source,
            dealer_id=dealer.id,
            car_model_id=car_model.id,
            title=payload.title,
            price=price,
            original_price=(
                Decimal(str(payload.original_price)) if payload.original_price else None
            ),
            currency=payload.currency,
            year=payload.year,
            mileage_km=payload.mileage_km,
            power_hp=payload.power_hp,
            condition=payload.condition,
            fuel_type=payload.fuel_type,
            transmission=payload.transmission,
            location=payload.location,
            image_url=payload.image_url,
            raw=payload.raw,
            status=OfferStatus.ACTIVE,
            first_seen_at=utcnow(),
            last_seen_at=utcnow(),
        )
        session.add(offer)
        await session.flush()
        session.add(OfferPriceHistory(offer_id=offer.id, price=price))
        return offer, True

    # Ya existía: refrescamos datos y anotamos el precio si cambió.
    if existing.price != price:
        session.add(OfferPriceHistory(offer_id=existing.id, price=price))
    existing.price = price
    existing.title = payload.title
    existing.last_seen_at = utcnow()
    existing.dealer_id = dealer.id
    existing.car_model_id = car_model.id
    existing.external_id = payload.external_id or existing.external_id
    existing.source = payload.source or existing.source
    if payload.original_price:
        existing.original_price = Decimal(str(payload.original_price))
    existing.currency = payload.currency
    existing.year = payload.year if payload.year is not None else existing.year
    existing.mileage_km = (
        payload.mileage_km if payload.mileage_km is not None else existing.mileage_km
    )
    existing.power_hp = payload.power_hp if payload.power_hp is not None else existing.power_hp
    existing.condition = payload.condition
    existing.fuel_type = payload.fuel_type or existing.fuel_type
    existing.transmission = payload.transmission or existing.transmission
    existing.location = payload.location or existing.location
    existing.image_url = payload.image_url or existing.image_url
    if payload.raw is not None:
        existing.raw = payload.raw
    # Una oferta descartada a mano NO se reactiva al volver a verla; una expirada sí.
    # Con ella se va la marca de quién la retiró y cuándo: si se quedara, una
    # oferta activa arrastraría un «retirada el 3 de marzo» que ya no es verdad,
    # y el motivo escrito entonces («la llamé y estaba vendida») describiría un
    # anuncio que vuelve a estar publicado.
    if existing.status == OfferStatus.EXPIRED:
        existing.status = OfferStatus.ACTIVE
        existing.dismissed_at = None
        existing.dismissed_by_id = None
        existing.dismiss_reason = None

    return existing, False


async def ingest_offers(
    session: AsyncSession, raw_offers: Sequence[OfferIngest | dict[str, Any]]
) -> IngestResult:
    """Ingesta en lote. Ni un fallo de validación ni uno de BD tumban el lote."""
    result = IngestResult()
    for index, raw in enumerate(raw_offers):
        try:
            payload = raw if isinstance(raw, OfferIngest) else OfferIngest.model_validate(raw)
        except ValidationError as exc:
            result.skipped += 1
            identifier = raw.get("url") if isinstance(raw, dict) else None
            result.errors.append(f"[{index}] {identifier or 'sin url'}: {_summarize(exc)}")
            continue

        savepoint = await session.begin_nested()
        try:
            offer, created = await upsert_offer(session, payload)
            await savepoint.commit()
            result.offer_ids.append(offer.id)
            if created:
                result.created += 1
            else:
                result.updated += 1
        except Exception as exc:  # noqa: BLE001 — se reporta por oferta
            await savepoint.rollback()
            result.skipped += 1
            result.errors.append(f"[{index}] {payload.url}: {exc}")
            logger.warning("Oferta descartada en la ingesta (%s): %s", payload.url, exc)

    await session.commit()
    return result
