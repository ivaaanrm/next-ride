"""Carga datos de demostración para poder ver la plataforma funcionando.

    docker compose exec backend python -m scripts.seed_demo

Es idempotente: la ingesta hace upsert por URL, así que se puede ejecutar varias veces.
"""

from __future__ import annotations

import asyncio
import random
from decimal import Decimal

from sqlalchemy import select

from app.db.session import SessionFactory
from app.models import CarModel, Dealer, TrackedModel, User
from app.models.offer import FuelType, Transmission, VehicleCondition
from app.schemas.offer import OfferIngest
from app.services.offers import ingest_offers

DEALERS = [
    ("Autos Ribera", "https://autosribera.example", "Madrid", "ES", 4.4),
    ("MotorPlus Levante", "https://motorplus.example", "Valencia", "ES", 3.9),
    ("Concesur Norte", "https://concesur.example", "Bilbao", "ES", 4.7),
    ("CarOutlet Sur", "https://caroutlet.example", "Sevilla", "ES", 3.2),
    ("Premium Wheels", "https://premiumwheels.example", "Barcelona", "ES", 4.1),
]

# (marca, modelo, acabado, PVP de referencia, precio base, año base)
MODELS = [
    ("Toyota", "Corolla", "1.8 Hybrid Active", 29500, 24500, 2022, FuelType.HYBRID),
    ("Volkswagen", "Golf", "1.5 eTSI Life", 33000, 27900, 2022, FuelType.PETROL),
    ("Tesla", "Model 3", "Long Range AWD", 52000, 41500, 2023, FuelType.ELECTRIC),
    ("Skoda", "Octavia", "2.0 TDI Ambition", 31000, 25200, 2021, FuelType.DIESEL),
]


async def main() -> None:
    random.seed(7)

    async with SessionFactory() as session:
        payloads: list[OfferIngest] = []
        for make, model, trim, reference, base_price, base_year, fuel in MODELS:
            for index, (name, website, city, country, _rating) in enumerate(DEALERS):
                # Dispersión de precio/km/año para que las métricas tengan señal.
                spread = random.uniform(-0.14, 0.16)
                price = round(base_price * (1 + spread), -1)
                mileage = random.choice([9_800, 24_500, 38_000, 52_400, 67_900, 81_300])
                year = base_year - random.choice([0, 0, 1, 2])
                condition = (
                    VehicleCondition.KM0
                    if mileage < 12_000
                    else VehicleCondition.USED
                )
                has_discount = random.random() < 0.6
                slug = f"{make}-{model}-{index}".lower().replace(" ", "-")

                payloads.append(
                    OfferIngest(
                        url=f"{website}/coches/{slug}",
                        title=f"{make} {model} {trim} ({year})",
                        price=price,
                        original_price=round(price * random.uniform(1.05, 1.18), -1)
                        if has_discount
                        else None,
                        dealer_name=name,
                        dealer_website=website,
                        dealer_city=city,
                        dealer_country=country,
                        make=make,
                        model=model,
                        trim=trim,
                        external_id=f"demo-{slug}",
                        source="demo-seed",
                        year=year,
                        mileage_km=mileage,
                        power_hp=random.choice([122, 140, 150, 190, 283]),
                        condition=condition,
                        fuel_type=fuel,
                        transmission=random.choice(
                            [Transmission.MANUAL, Transmission.AUTOMATIC]
                        ),
                        location=city,
                    )
                )

        result = await ingest_offers(session, payloads)
        print(
            f"Ofertas -> creadas: {result.created}, actualizadas: {result.updated}, "
            f"descartadas: {result.skipped}"
        )
        for error in result.errors[:5]:
            print(f"  ! {error}")

        # Precios de referencia (PVP) por modelo.
        for make, model, trim, reference, *_ in MODELS:
            car_model = await session.scalar(
                select(CarModel).where(
                    CarModel.make == make, CarModel.model == model, CarModel.trim == trim
                )
            )
            if car_model and car_model.reference_price is None:
                car_model.reference_price = Decimal(str(reference))

        # Valoración de los dealers.
        for name, _website, _city, _country, rating in DEALERS:
            dealer = await session.scalar(select(Dealer).where(Dealer.name == name))
            if dealer and dealer.rating is None:
                dealer.rating = rating

        # El primer usuario sigue dos modelos, para que la vista arranque con datos.
        user = await session.scalar(select(User).order_by(User.id).limit(1))
        if user:
            for make, model, trim, *_ in MODELS[:2]:
                car_model = await session.scalar(
                    select(CarModel).where(
                        CarModel.make == make,
                        CarModel.model == model,
                        CarModel.trim == trim,
                    )
                )
                if car_model is None:
                    continue
                already = await session.scalar(
                    select(TrackedModel).where(
                        TrackedModel.user_id == user.id,
                        TrackedModel.car_model_id == car_model.id,
                    )
                )
                if already is None:
                    session.add(
                        TrackedModel(user_id=user.id, car_model_id=car_model.id)
                    )
            print(f"Modelos seguidos asignados a {user.email}")

        await session.commit()
        print("Seed de demo completado.")


if __name__ == "__main__":
    asyncio.run(main())
