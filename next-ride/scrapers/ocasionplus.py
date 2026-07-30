"""Normaliza capturas de tarjetas de OcasionPlus hechas con Playwright/browser.

OcasionPlus se accede con ``access: playwright``. La captura interactiva usa:

* tarjeta: ``a[href*="/coches-segunda-mano/{modelo}"]``
* marca/modelo: ``[data-test="span-brand-model"]``
* versión: ``[data-test="span-version"]``
* precio de contado: ``[data-test="span-price"]``; si no existe, el único
  ``[data-test="span-finance"]`` es el precio de contado
* año, km, combustible y cambio: los ``data-test`` de ``span-registration-date``,
  ``span-km``, ``span-fuel-type`` y ``span-engine-transmission``
* delegación: ``[data-test="div-dealer"]``

El navegador guarda una captura JSON compacta. Este módulo hace deterministas la
normalización y la forma final que consume ``ingest.py``.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path
from typing import Any

from config import ConfigError, load_runtime_config

ROOT = Path(__file__).resolve().parent.parent
DEALER = "ocasionplus"
BASE = "https://www.ocasionplus.com"

# La captura guarda las etiquetas tal cual las pinta el portal. El mapeo al enum
# de la API vive aquí, no en el navegador, para que sea reproducible sobre el
# fixture. Los valores ya normalizados pasan tal cual (capturas antiguas).
FUEL_MAP = {
    "diesel": "diesel",
    "diésel": "diesel",
    "gasolina": "petrol",
    "petrol": "petrol",
    "híbrido": "hybrid",
    "hibrido": "hybrid",
    "hybrid": "hybrid",
    "híbrido enchufable": "plugin_hybrid",
    "hibrido enchufable": "plugin_hybrid",
    "plugin_hybrid": "plugin_hybrid",
    "eléctrico": "electric",
    "electrico": "electric",
    "electric": "electric",
    "glp": "lpg",
    "lpg": "lpg",
    "gnc": "other",
}

TRANSMISSION_MAP = {
    "manual": "manual",
    "automático": "automatic",
    "automatico": "automatic",
    "automática": "automatic",
    "automatic": "automatic",
}


def _cash_price(card: dict[str, Any]) -> int | None:
    """SKILL.md: manda `span-price`; si no existe, el único importe visible
    (`span-finance`) es el precio de contado de esa tarjeta."""
    price = card.get("p")
    return price if price is not None else card.get("fin")


def normalize(
    target: dict[str, Any], card: dict[str, Any], scraped_at: str
) -> dict[str, Any]:
    label = target["label"]
    location = card["l"]
    return {
        "url": card["u"],
        "title": f"{label} {card['t']} ({card['y']})",
        "price": _cash_price(card),
        "original_price": None,
        "dealer_name": f"OcasionPlus {location}",
        "dealer_website": BASE,
        "dealer_city": location.split(" - ")[-1],
        "dealer_country": "ES",
        "make": target["make"],
        "model": target["model"],
        "trim": card["t"][:120],
        "currency": "EUR",
        "external_id": card["u"].rsplit("-", 1)[-1],
        "source": DEALER,
        "year": card["y"],
        "mileage_km": card["k"],
        "power_hp": card["h"],
        "condition": "km0" if card["k"] <= 100 else "used",
        "fuel_type": FUEL_MAP.get(str(card["f"] or "").strip().casefold()),
        "transmission": TRANSMISSION_MAP.get(str(card["x"] or "").strip().casefold()),
        "location": location,
        "image_url": card.get("i"),
        "raw": {
            "scraped_at": scraped_at,
            "dealer": DEALER,
            "selection_rule": "source order; quantity first",
            "fuel_label": card["f"],
            "transmission_label": card["x"],
            "prices": {"cash": card.get("p"), "financed": card.get("fin")},
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
    cards = target_data.get("candidates") or target_data.get("offers") or []
    by_url: dict[str, dict[str, Any]] = {}
    for card in cards:
        by_url.setdefault(card["u"], normalize(target, card, snapshot["scraped_at"]))
    offers = list(by_url.values())
    for offer in offers:
        offer["raw"]["selection_pool"] = len(offers)
    return {
        "dealer": DEALER,
        "target": label,
        "url": target_data["url"],
        "listing_count": target_data["listing_count"],
        "cards_seen": len(cards),
        "offers": offers[:max_per_target],
        "reserved": [],
    }


def _slug(value: str) -> str:
    ascii_value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", ascii_value.casefold())).strip("-")


def main() -> int:
    parser = argparse.ArgumentParser(description="Normaliza una captura browser de OcasionPlus")
    parser.add_argument(
        "--snapshot",
        type=Path,
        default=ROOT / "state" / "ocasionplus-browser-candidates.json",
    )
    parser.add_argument("--out-dir", type=Path, default=ROOT / "state")
    parser.add_argument("--max", type=int)
    parser.add_argument("--config", type=Path)
    args = parser.parse_args()

    snapshot = json.loads(args.snapshot.read_text("utf-8"))
    args.out_dir.mkdir(parents=True, exist_ok=True)
    runtime = load_runtime_config(args.config)
    active = {
        target["label"].casefold(): target
        for target in runtime["targets"]
        if target["source"]["key"] == DEALER
    }
    for snapshot_label in snapshot["targets"]:
        config = active.get(snapshot_label.casefold())
        if config is None:
            raise ValueError(
                f"{snapshot_label}: no está activo en la configuración de la API"
            )
        limit = args.max or config["max_results"]
        result = build(snapshot, config, limit, snapshot_label)
        label = config["label"]
        path = args.out_dir / f"raw-ocasionplus-{_slug(label)}.json"
        path.write_text(json.dumps(result, ensure_ascii=False, indent=1), "utf-8")
        print(f"{label}: {len(result['offers'])}/{limit} ofertas -> {path}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ConfigError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc
