"""Normaliza capturas del listado público de coches.net hechas con el navegador.

Hay dos formatos de captura y este módulo acepta los dos:

`initial_props` (preferido)
    El listado es una app que embute su estado en
    `window.__INITIAL_PROPS__.initialResults`. Ahí están los 35 anuncios de la
    página con datos ya estructurados: `price` (contado), `financedPrice`,
    `km`, `year`, `hp`, `fuelType`, `seller.name` y la URL semántica. No hay que
    leer selectores CSS ni esperar a que hidraten las tarjetas, que es lo que
    hace frágil la captura del DOM: fuera del viewport las tarjetas se quedan
    vacías y solo se recogen 4-5 de 35.

`candidates` (heredado)
    La captura antigua de tarjetas del DOM (`.mt-ListAds-item.mt-CardAd`), con
    los textos tal cual se pintan. Se conserva para poder releer los fixtures
    antiguos.

En ambos casos se elimina lo que no es un anuncio, se deduplica por URL
canónica y se conservan hasta `max_results` en el orden del portal, sin rankear.

Uso:
    python3 scrapers/cochesnet.py \
      --snapshot state/cochesnet-initial-props.json \
      --fixture scrapers/fixtures/cochesnet-initial-props.json \
      --out-dir state
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import unicodedata
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from config import ConfigError, load_runtime_config

ROOT = Path(__file__).resolve().parent.parent
DEALER_ID = "coches.net"
BASE = "https://www.coches.net"

FUEL_MAP = {
    "diesel": "diesel",
    "gasolina": "petrol",
    "hibrido": "hybrid",
    "hibrido enchufable": "plugin_hybrid",
    "electrico": "electric",
    "glp": "lpg",
}

AUTOMATIC_RE = re.compile(
    r"\b(?:s[\s-]?tronic|s\s+tron|str\b|tiptronic|dsg|dct|cvt|steptronic|aut(?:omatic[oa]?)?\.?)\b",
    re.IGNORECASE,
)
EXTERNAL_ID_RE = re.compile(r"-(\d+)-covo\.aspx(?:\?.*)?$", re.IGNORECASE)


class NormalizerError(RuntimeError):
    """La captura ya no tiene la forma esperada."""


def _ascii(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    return "".join(char for char in text if not unicodedata.combining(char)).strip().casefold()


def _integer(value: Any) -> int | None:
    digits = re.sub(r"\D", "", str(value or ""))
    return int(digits) if digits else None


def _fields(card: dict[str, Any]) -> dict[str, Any]:
    attrs = [str(value).strip() for value in card.get("attrs", []) if str(value).strip()]
    fuel_label = next((value for value in attrs if _ascii(value) in FUEL_MAP), None)
    year_label = next((value for value in attrs if re.fullmatch(r"20\d{2}|19\d{2}", value)), None)
    km_label = next((value for value in attrs if re.search(r"\bkm\b", value, re.IGNORECASE)), None)
    hp_label = next((value for value in attrs if re.search(r"\bcv\b", value, re.IGNORECASE)), None)
    known = {fuel_label, year_label, km_label, hp_label}
    location = next((value for value in reversed(attrs) if value not in known), None)
    return {
        "fuel_label": fuel_label,
        "fuel_type": FUEL_MAP.get(_ascii(fuel_label), "other"),
        "year": _integer(year_label),
        "mileage_km": _integer(km_label),
        "power_hp": _integer(hp_label),
        "location": location,
    }


def _trim(title: str, model: str) -> str:
    position = title.casefold().find(model.casefold())
    if position >= 0:
        return title[position + len(model):].strip()[:120]
    return title[:120]


def _external_id(url: str) -> str:
    match = EXTERNAL_ID_RE.search(url)
    if not match:
        raise NormalizerError(f"URL sin id de anuncio: {url}")
    return match.group(1)


def _canonical_url(url: str, make: Any = None, model: Any = None) -> str:
    """`/{marca}-{modelo}-{id}-covo.aspx`, que es la identidad estable del anuncio.

    coches.net sirve el mismo anuncio con una URL semántica larga que incluye
    versión, año y provincia. Esa URL cambia si el vendedor edita el anuncio, y
    `url` es la clave natural contra la que deduplica `state/seen.json`: sin
    canonicalizar, el mismo coche entraría dos veces en la plataforma.
    """
    parsed = urlsplit(url)
    path = parsed.path
    match = EXTERNAL_ID_RE.search(path)
    if match and make and model:
        path = f"/{_slug(make)}-{_slug(model)}-{match.group(1)}-covo.aspx"
    return urlunsplit((parsed.scheme or "https", parsed.netloc or "www.coches.net", path, "", ""))


def _slug(value: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", _ascii(value))).strip("-")


def normalize(
    target: dict[str, Any], card: dict[str, Any], scraped_at: str
) -> dict[str, Any] | None:
    title = str(card.get("title") or "").strip()
    url = str(card.get("url") or "").strip()
    if not title or not url:
        return None

    fields = _fields(card)
    year = fields["year"]
    external_id = _external_id(url)
    return {
        "url": _canonical_url(url, card.get("make"), card.get("model")),
        "title": f"{title} ({year})" if year else title,
        "price": _integer(card.get("cash")),
        "original_price": None,
        "dealer_name": "Coches.net",
        "dealer_website": BASE,
        "dealer_city": fields["location"],
        "dealer_country": "ES",
        "make": target["make"],
        "model": target["model"],
        "trim": _trim(title, target["model"]),
        "currency": "EUR",
        "external_id": f"cochesnet-{external_id}",
        "source": DEALER_ID,
        "year": year,
        "mileage_km": fields["mileage_km"],
        "power_hp": fields["power_hp"],
        "condition": "km0" if (fields["mileage_km"] or 1) <= 100 else "used",
        "fuel_type": fields["fuel_type"],
        "transmission": "automatic" if AUTOMATIC_RE.search(title) else "manual",
        "location": fields["location"],
        "image_url": card.get("image"),
        "raw": {
            "scraped_at": scraped_at,
            "dealer": DEALER_ID,
            "source_url": url,
            "fuel_label": fields["fuel_label"],
            "tags": card.get("tags", []),
        },
    }


def normalize_item(
    target: dict[str, Any], item: dict[str, Any], scraped_at: str
) -> dict[str, Any] | None:
    """Normaliza un anuncio de `initialResults.items`.

    Precios: `price` es el de contado (el que la tarjeta rotula "Contado") y
    `financedPrice` el financiado, que casi siempre es menor. SKILL.md pide el
    de contado, así que `financedPrice` solo se guarda en `raw` para auditar.
    No es un precio tachado, luego `original_price` se queda a None.
    """
    title = str(item.get("title") or "").strip()
    path = str(item.get("url") or "").strip()
    if not title or not path:
        return None

    year = item.get("year")
    km = item.get("km")
    fuel_label = item.get("fuelType")
    return {
        "url": _canonical_url(f"{BASE}{path}", item.get("make"), item.get("model")),
        "title": f"{title} ({year})" if year else title,
        "price": item.get("price"),
        "original_price": None,
        "dealer_name": "Coches.net",
        "dealer_website": BASE,
        "dealer_city": item.get("province"),
        "dealer_country": "ES",
        "make": target["make"],
        "model": target["model"],
        "trim": _trim(title, target["model"]),
        "currency": "EUR",
        "external_id": f"cochesnet-{item['id']}",
        "source": DEALER_ID,
        "year": year,
        "mileage_km": km,
        "power_hp": item.get("hp"),
        "condition": "km0" if (km if km is not None else 1) <= 100 else "used",
        # Sin etiqueta de combustible se deja a None: es mejor un hueco que un
        # `other` inventado.
        "fuel_type": FUEL_MAP.get(_ascii(fuel_label), "other") if fuel_label else None,
        "transmission": "automatic" if AUTOMATIC_RE.search(title) else "manual",
        "location": item.get("province"),
        "image_url": item.get("imgUrl"),
        "raw": {
            "scraped_at": scraped_at,
            "dealer": DEALER_ID,
            "source_url": f"{BASE}{path}",
            "fuel_label": fuel_label,
            "environmental_label": item.get("environmentalLabel"),
            # El vendedor real del marketplace. `dealer_name` sigue siendo
            # "Coches.net" para no partir en dos las 45 ofertas ya publicadas.
            "seller": item.get("seller"),
            "prices": {"cash": item.get("price"), "financed": item.get("financedPrice")},
        },
    }


def build(
    snapshot: dict[str, Any],
    target: dict[str, Any],
    max_per_target: int,
    snapshot_label: str | None = None,
) -> dict[str, Any]:
    label = target["label"]
    target_data = snapshot["targets"][snapshot_label or label]
    items = target_data.get("items")
    candidates = target_data.get("candidates")
    if items is None and candidates is None:
        raise NormalizerError(f"{label}: la captura no trae ni items[] ni candidates[]")
    source_rows = items if items is not None else candidates
    by_url: dict[str, dict[str, Any]] = {}
    for row in source_rows:
        offer = (
            normalize_item(target, row, snapshot["scraped_at"])
            if items is not None
            else normalize(target, row, snapshot["scraped_at"])
        )
        if offer is not None:
            by_url.setdefault(offer["url"], offer)
    offers = list(by_url.values())
    for offer in offers:
        offer["raw"]["selection_pool"] = len(offers)
        offer["raw"]["selection_rule"] = "source order; quantity first"
    return {
        "dealer": DEALER_ID,
        "target": label,
        "url": target_data["url"],
        "listing_count": target_data["listing_count"],
        "cards_seen": len(source_rows),
        "usable_candidates": len(offers),
        "offers": offers[:max_per_target],
        "reserved": [],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Normaliza una captura browser de coches.net")
    parser.add_argument(
        "--snapshot",
        type=Path,
        default=ROOT / "state" / "cochesnet-browser-candidates.json",
    )
    parser.add_argument("--out-dir", type=Path, default=ROOT / "state")
    parser.add_argument("--fixture", type=Path)
    parser.add_argument("--max", type=int)
    parser.add_argument("--config", type=Path)
    args = parser.parse_args()

    snapshot = json.loads(args.snapshot.read_text("utf-8"))
    args.out_dir.mkdir(parents=True, exist_ok=True)
    if args.fixture:
        args.fixture.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(args.snapshot, args.fixture)

    runtime = load_runtime_config(args.config)
    targets = {
        target["label"].casefold(): target
        for target in runtime["targets"]
        if target["source"]["key"] == DEALER_ID
    }
    for snapshot_label in snapshot["targets"]:
        target = targets.get(snapshot_label.casefold())
        if target is None:
            raise NormalizerError(
                f"{snapshot_label}: no está activo en la configuración de la API"
            )
        limit = args.max or target["max_results"]
        result = build(snapshot, target, limit, snapshot_label)
        label = target["label"]
        path = args.out_dir / f"raw-cochesnet-{_slug(label)}.json"
        path.write_text(json.dumps(result, ensure_ascii=False, indent=1), "utf-8")
        print(
            f"{label}: {result['usable_candidates']} válidas, "
            f"{len(result['offers'])}/{limit} capturadas -> {path}"
        )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ConfigError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc
