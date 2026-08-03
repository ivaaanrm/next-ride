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
from app.schemas.offer import EDITABLE_FIELDS, IngestResult, OfferIngest, OfferUpdate
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
    #
    # Salvo lo que haya corregido una persona. `manual_fields` son las columnas
    # que ganó la mano y el scraper no vuelve a escribir: sin eso, arreglar un año
    # mal parseado duraría hasta el siguiente rastreo y la corrección sería un
    # gesto decorativo. La procedencia (`external_id`, `source`, `raw`) y las
    # fechas de rastreo quedan siempre en manos del scraper: no son editables.
    pinned = set(existing.manual_fields or ())

    def fresh(field: str, value: Any) -> Any:
        """El valor del scraper, o el que hay si la columna está anclada."""
        return getattr(existing, field) if field in pinned else value

    if "price" not in pinned:
        if existing.price != price:
            session.add(OfferPriceHistory(offer_id=existing.id, price=price))
        existing.price = price
    existing.title = fresh("title", payload.title)
    existing.last_seen_at = utcnow()
    existing.dealer_id = fresh("dealer_id", dealer.id)
    existing.car_model_id = fresh("car_model_id", car_model.id)
    existing.external_id = payload.external_id or existing.external_id
    existing.source = payload.source or existing.source
    if payload.original_price:
        existing.original_price = fresh(
            "original_price", Decimal(str(payload.original_price))
        )
    existing.currency = fresh("currency", payload.currency)
    existing.year = fresh(
        "year", payload.year if payload.year is not None else existing.year
    )
    existing.mileage_km = fresh(
        "mileage_km",
        payload.mileage_km if payload.mileage_km is not None else existing.mileage_km,
    )
    existing.power_hp = fresh(
        "power_hp", payload.power_hp if payload.power_hp is not None else existing.power_hp
    )
    existing.condition = fresh("condition", payload.condition)
    existing.fuel_type = fresh("fuel_type", payload.fuel_type or existing.fuel_type)
    existing.transmission = fresh(
        "transmission", payload.transmission or existing.transmission
    )
    existing.location = fresh("location", payload.location or existing.location)
    existing.image_url = fresh("image_url", payload.image_url or existing.image_url)
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


async def apply_manual_edit(
    session: AsyncSession, offer: Offer, payload: OfferUpdate, user_id: int
) -> Offer:
    """Escribe una corrección manual y **ancla** los campos que ha tocado.

    Anclar es la mitad que importa: `upsert_offer` reescribe la fila en cada pase
    del scraper, así que sin `manual_fields` la corrección viviría hasta el
    siguiente rastreo. Se anclan los campos que vienen en el cuerpo, no los que
    han cambiado de valor: confirmar a mano el dato que ya estaba también es
    decir «este lo llevo yo».

    No se recalcula nada aquí porque no hay nada que recalcular: las métricas y
    la puntuación se computan al leer (ver `services/metrics`), así que corregir
    un año arregla el km/año, el valor esperado y el `value_score` en la misma
    respuesta. Lo que **no** se rehace es el veredicto del agente de IA: es de un
    run pasado, se hizo sobre los datos de entonces y se queda como estaba hasta
    que se vuelva a lanzar.
    """
    changes = payload.model_dump(exclude_unset=True, exclude={"clear_manual"})
    pinned: set[str] = set() if payload.clear_manual else set(offer.manual_fields or ())

    if "price" in changes:
        price = Decimal(str(changes.pop("price")))
        # La corrección se anota en el historial como cualquier otro cambio de
        # precio. No es un movimiento del mercado y no lo aparenta —lleva su
        # fecha, que es la de hoy—, pero si no se anotara, el último punto de la
        # serie dejaría de coincidir con el precio de la ficha y el gráfico
        # contaría una historia distinta de la que dice la cabecera.
        if offer.price != price:
            session.add(OfferPriceHistory(offer_id=offer.id, price=price))
        offer.price = price

    if "original_price" in changes:
        original = changes.pop("original_price")
        offer.original_price = None if original is None else Decimal(str(original))

    for field, value in changes.items():
        setattr(offer, field, value)

    # Lista nueva y no un `append`: SQLAlchemy no vigila las mutaciones en sitio
    # de una columna JSON, así que lo añadido dentro no llegaría a la base.
    offer.manual_fields = sorted(
        (pinned | payload.model_fields_set) & set(EDITABLE_FIELDS)
    )
    offer.edited_at = utcnow()
    offer.edited_by_id = user_id
    return offer


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
