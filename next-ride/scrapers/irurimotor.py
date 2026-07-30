"""Extractor determinista de Iruri Motor (access: fetch).

Iruri Motor publica el inventario mediante el endpoint JSON de Vehica indicado
por la API. Para cada target se incluyen todas las variantes cuyo nombre empieza
por su marca y modelo configurados. Se conserva el orden del inventario para
maximizar cobertura, sin ranking.

Uso:
    python3 scrapers/irurimotor.py "Mitsubishi Montero" --max 15 \
      --fixture scrapers/fixtures/irurimotor-mitsubishi.json \
      --out state/raw-irurimotor-mitsubishi-montero.json
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from config import ConfigError, find_target

ROOT = Path(__file__).resolve().parent.parent
DEALER_ID = "irurimotor"
BASE = "https://irurimotor.com"
USER_AGENT = "Mozilla/5.0 (compatible; NextRideResearch/1.0)"
REQUEST_DELAY_S = 2.0
TIMEOUT_S = 40

FUEL_MAP = {
    "diesel": "diesel",
    "diésel": "diesel",
    "gasolina": "petrol",
    "hibrido": "hybrid",
    "híbrido": "hybrid",
    "electrico": "electric",
    "eléctrico": "electric",
    "glp": "lpg",
}

TRANSMISSION_MAP = {
    "manual": "manual",
    "automatico": "automatic",
    "automático": "automatic",
    "automatica": "automatic",
    "automática": "automatic",
}

_last_request_at = 0.0


class ExtractorError(RuntimeError):
    """La respuesta pública ya no tiene la forma esperada."""


def _throttle() -> None:
    global _last_request_at
    wait = REQUEST_DELAY_S - (time.monotonic() - _last_request_at)
    if wait > 0:
        time.sleep(wait)
    _last_request_at = time.monotonic()


def fetch_json(url: str) -> tuple[dict[str, Any], bytes]:
    _throttle()
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
            "Accept-Language": "es-ES,es;q=0.9",
        },
    )
    with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
        raw = response.read()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ExtractorError("el endpoint de Vehica no devolvio JSON") from exc
    if not isinstance(payload.get("results"), list):
        raise ExtractorError("falta results[] en la respuesta de Vehica")
    return payload, raw


def _attribute(car: dict[str, Any], name: str) -> dict[str, Any] | None:
    return next((item for item in car.get("attributes", []) if item.get("name") == name), None)


def _value(car: dict[str, Any], name: str) -> Any:
    attribute = _attribute(car, name)
    return attribute.get("value") if attribute else None


def _taxonomy(car: dict[str, Any], name: str) -> str | None:
    value = _value(car, name)
    if isinstance(value, list) and value:
        return value[0].get("name")
    return None


def _price(car: dict[str, Any]) -> int | None:
    value = _value(car, "Precio al contado")
    if not isinstance(value, dict):
        return None
    for candidate in value.values():
        if isinstance(candidate, (int, float)) and candidate > 0:
            return int(candidate)
    return None


def _image(car: dict[str, Any]) -> str | None:
    gallery = _attribute(car, "Galería") or {}
    images = gallery.get("images") or []
    if images:
        return images[0].get("url") or images[0].get("thumb")
    return None


def _norm(value: Any) -> str:
    return str(value or "").strip().casefold()


def _trim(name: str, make: str, model: str) -> str:
    prefix = f"{make} {model}"
    return name[len(prefix):].strip()[:120] if name.casefold().startswith(prefix.casefold()) else name[:120]


def normalize(
    car: dict[str, Any], make: str, model: str, scraped_at: str
) -> dict[str, Any]:
    year = _value(car, "Año")
    mileage = _value(car, "Kilómetros")
    fuel_label = _taxonomy(car, "Combustible")
    transmission_label = _taxonomy(car, "Cambio")
    name = str(car.get("name") or "").strip()
    return {
        "url": car.get("url"),
        "title": f"{name} ({year})" if year else name,
        "price": _price(car),
        "original_price": None,
        "dealer_name": "Iruri Motor Sunbilla",
        "dealer_website": BASE,
        "dealer_city": "Sunbilla",
        "dealer_country": "ES",
        "make": make,
        "model": model,
        "trim": _trim(name, make, model),
        "currency": "EUR",
        "external_id": str(car.get("id") or ""),
        "source": DEALER_ID,
        "year": year,
        "mileage_km": mileage,
        "power_hp": _value(car, "Potencia (CV)"),
        "condition": "used",
        "fuel_type": FUEL_MAP.get(_norm(fuel_label), "other"),
        "transmission": TRANSMISSION_MAP.get(_norm(transmission_label), "other"),
        "location": "Sunbilla, Navarra",
        "image_url": _image(car),
        "raw": {
            "scraped_at": scraped_at,
            "dealer": DEALER_ID,
            "source_model": _taxonomy(car, "Modelo"),
            "fuel_label": fuel_label,
            "transmission_label": transmission_label,
        },
    }


def extract(
    target: str,
    dealer_cfg: dict[str, Any],
    max_per_target: int = 15,
    *,
    save_fixture: Path | None = None,
) -> dict[str, Any]:
    make = str(dealer_cfg["make"])
    model = str(dealer_cfg["model"])
    url = dealer_cfg.get("search_url")
    if not url:
        raise ExtractorError(f"la API no devolvió una URL resuelta para {target!r}")
    payload, raw = fetch_json(url)
    if save_fixture:
        save_fixture.parent.mkdir(parents=True, exist_ok=True)
        save_fixture.write_bytes(raw)

    scraped_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    prefix = f"{make} {model}".casefold()
    cars = [
        car
        for car in payload["results"]
        if str(car.get("name") or "").casefold().startswith(prefix)
    ]
    offers = [normalize(car, make, model, scraped_at) for car in cars]
    selected = offers[:max_per_target]
    for offer in selected:
        offer["raw"]["selection_pool"] = len(offers)
        offer["raw"]["selection_rule"] = "source order; quantity first"

    return {
        "dealer": DEALER_ID,
        "target": target,
        "url": dealer_cfg.get("listing_url") or url,
        "listing_count": len(offers),
        "source_listing_count": payload.get("resultsCount", len(payload["results"])),
        "cards_seen": len(payload["results"]),
        "offers": selected,
        "reserved": [],
    }


def load_dealer_cfg(target: str, path: Path | None = None) -> dict[str, Any]:
    runtime_target = find_target(DEALER_ID, target, path)
    source = runtime_target["source"]
    return {
        "make": runtime_target["make"],
        "model": runtime_target["model"],
        "search_url": runtime_target.get("search_url"),
        "listing_url": source.get("listing_url"),
        "search_params": runtime_target.get("search_params", {}),
        "max_results": runtime_target["max_results"],
        **source.get("config", {}),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Extractor de Iruri Motor")
    parser.add_argument("target", help='p. ej. "Mitsubishi Montero"')
    parser.add_argument("--max", type=int)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--fixture", type=Path)
    parser.add_argument("--config", type=Path)
    args = parser.parse_args()

    dealer_cfg = load_dealer_cfg(args.target, args.config)
    result = extract(
        args.target,
        dealer_cfg,
        args.max or dealer_cfg["max_results"],
        save_fixture=args.fixture,
    )
    text = json.dumps(result, ensure_ascii=False, indent=1)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text, "utf-8")
        print(f"{len(result['offers'])} ofertas -> {args.out}")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ConfigError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc
