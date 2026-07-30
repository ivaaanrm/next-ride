"""Resolución (get-or-create) de dealers y modelos, más generación de slugs."""

from __future__ import annotations

import re
import unicodedata

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import CarModel, Dealer


def slugify(*parts: str | None) -> str:
    text = " ".join(part for part in parts if part)
    normalized = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", normalized).strip("-").lower()
    return slug or "sin-nombre"


async def get_or_create_dealer(
    session: AsyncSession,
    name: str,
    *,
    website: str | None = None,
    city: str | None = None,
    country: str | None = None,
) -> Dealer:
    slug = slugify(name)
    dealer = await session.scalar(select(Dealer).where(Dealer.slug == slug))
    if dealer:
        # Completamos huecos sin sobrescribir lo que ya se curó a mano.
        dealer.website = dealer.website or website
        dealer.city = dealer.city or city
        dealer.country = dealer.country or country
        return dealer

    dealer = Dealer(slug=slug, name=name, website=website, city=city, country=country)
    session.add(dealer)
    await session.flush()
    return dealer


async def get_or_create_car_model(
    session: AsyncSession, make: str, model: str, trim: str = ""
) -> CarModel:
    slug = slugify(make, model, trim)
    car_model = await session.scalar(select(CarModel).where(CarModel.slug == slug))
    if car_model:
        return car_model

    car_model = CarModel(slug=slug, make=make.strip(), model=model.strip(), trim=trim.strip())
    session.add(car_model)
    await session.flush()
    return car_model
