"""Configuración inicial de fuentes; después de crearla, la API es la autoridad."""

from __future__ import annotations

import re
import unicodedata
from string import Formatter
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ScrapeSource, ScrapeTarget
from app.models.scraping import canonical_make_model_key

DEFAULT_SOURCES: tuple[dict[str, Any], ...] = (
    {
        "key": "flexicar",
        "name": "Flexicar",
        "base_url": "https://www.flexicar.es",
        "search_url_template": ("https://www.flexicar.es/{make_slug}/{model_slug}/segunda-mano/"),
        "listing_url": None,
        "access": "fetch",
        "notes": (
            "El HTML trae __NEXT_DATA__. Contrastar el precio de la tarjeta con la ficha "
            "y usar el precio de contado de la ficha."
        ),
        "config": {
            "extractor": "scrapers/flexicar.py",
            "vehicles_api_url": "https://services.flexicar.es/api/v1/vehicles",
            "make_slug_aliases": {"mercedes": "mercedes-benz"},
            "_defaults_version": 2,
        },
    },
    {
        "key": "coches.net",
        "name": "Coches.net",
        "base_url": "https://www.coches.net",
        "search_url_template": (
            "https://www.coches.net/search/?MakeIds%5B0%5D={make_id}&ModelIds%5B0%5D={model_id}"
        ),
        "listing_url": None,
        "access": "playwright",
        "notes": (
            "Listado público renderizado con JavaScript. Usar Playwright y navegador "
            "real como fallback, siempre en modo de solo lectura."
        ),
        "config": {
            "extractor": "scrapers/cochesnet.py",
            "card_selector": ".mt-ListAds-item.mt-CardAd",
            "_defaults_version": 1,
        },
    },
    {
        "key": "ocasionplus",
        "name": "OcasionPlus",
        "base_url": "https://www.ocasionplus.com",
        "search_url_template": None,
        "listing_url": None,
        "access": "playwright",
        "notes": (
            "Descubrir la URL desde la interfaz pública y persistirla en el target. "
            "Usar navegador real como fallback y no superar tres páginas."
        ),
        "config": {
            "extractor": "scrapers/ocasionplus.py",
            "card_hint": "atributos data-test",
            "_defaults_version": 1,
        },
    },
    {
        "key": "irurimotor",
        "name": "Iruri Motor",
        "base_url": "https://irurimotor.com",
        "search_url_template": ("https://irurimotor.com/wp-json/vehica/v1/cars?marca={make_slug}"),
        "listing_url": (
            "https://irurimotor.com/todoterrenos-coches-de-segunda-mano-y-ocasion-"
            "sunbilla-navarra/?type=todoterrenos"
        ),
        "access": "fetch",
        "notes": "El endpoint público de Vehica entrega el inventario en JSON.",
        "config": {"extractor": "scrapers/irurimotor.py", "_defaults_version": 1},
    },
)

DEFAULT_TARGETS: tuple[dict[str, Any], ...] = (
    {
        "source_key": "flexicar",
        "make": "Audi",
        "model": "A4 Allroad quattro",
        "search_params": {"make_slug": "audi", "model_slug": "a4-allroad-quattro"},
    },
    {
        "source_key": "coches.net",
        "make": "Audi",
        "model": "A4 Allroad quattro",
        "search_params": {"make_id": 4, "model_id": 925},
    },
    {
        "source_key": "flexicar",
        "make": "Mercedes",
        "model": "Clase A",
        "search_params": {"make_slug": "mercedes-benz", "model_slug": "clase-a"},
    },
    {
        "source_key": "coches.net",
        "make": "Mercedes",
        "model": "Clase A",
        "search_params": {"make_id": 28, "model_id": 275},
    },
    {
        "source_key": "ocasionplus",
        "make": "Mercedes",
        "model": "Clase A",
        "search_params": {},
    },
    {
        "source_key": "flexicar",
        "make": "Audi",
        "model": "A3",
        "search_params": {"make_slug": "audi", "model_slug": "a3"},
    },
    {
        "source_key": "coches.net",
        "make": "Audi",
        "model": "A3",
        "search_params": {"make_id": 4, "model_id": 345},
    },
    {
        "source_key": "ocasionplus",
        "make": "Audi",
        "model": "A3",
        "search_params": {},
    },
    {
        "source_key": "irurimotor",
        "make": "Mitsubishi",
        "model": "Montero",
        "search_url": "https://irurimotor.com/wp-json/vehica/v1/cars?marca=mitsubishi",
        "search_params": {},
    },
)


def _slug(value: str) -> str:
    ascii_value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", ascii_value.casefold())).strip("-")


def default_search_params(source: ScrapeSource, make: str, model: str) -> dict[str, str]:
    """Completa parámetros deducibles; los IDs propios de portales se descubren."""

    template = source.search_url_template or ""
    fields = {
        field_name for _, field_name, _, _ in Formatter().parse(template) if field_name is not None
    }
    result: dict[str, str] = {}
    if "make_slug" in fields:
        aliases = source.config.get("make_slug_aliases", {})
        result["make_slug"] = str(aliases.get(make.casefold()) or _slug(make))
    if "model_slug" in fields:
        result["model_slug"] = _slug(model)
    return result


async def seed_scraping_config(session: AsyncSession) -> None:
    """Crea valores iniciales sin reescribir cambios hechos después por API."""

    sources_by_key = {source.key: source for source in await session.scalars(select(ScrapeSource))}
    for values in DEFAULT_SOURCES:
        key = str(values["key"])
        if key in sources_by_key:
            # Añade nuevos defaults sin pisar valores que el usuario haya
            # cambiado por API. El marcador hace cada migración idempotente.
            source = sources_by_key[key]
            defaults = values.get("config", {})
            desired_version = int(defaults.get("_defaults_version", 0))
            if int(source.config.get("_defaults_version", 0)) < desired_version:
                if not source.search_url_template:
                    source.search_url_template = values.get("search_url_template")
                source.config = {
                    **defaults,
                    **source.config,
                    "_defaults_version": desired_version,
                }
            continue
        source = ScrapeSource(**values)
        session.add(source)
        sources_by_key[key] = source

    await session.flush()

    existing = {
        (target.source_id, target.make_model_key)
        for target in await session.scalars(select(ScrapeTarget))
    }
    for values in DEFAULT_TARGETS:
        source = sources_by_key[str(values["source_key"])]
        key = canonical_make_model_key(str(values["make"]), str(values["model"]))
        if (source.id, key) in existing:
            continue
        target_values = {key: value for key, value in values.items() if key != "source_key"}
        session.add(
            ScrapeTarget(
                source_id=source.id,
                make_model_key=key,
                max_results=15,
                is_active=True,
                **target_values,
            )
        )

    await session.commit()
