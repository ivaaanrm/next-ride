"""Normaliza capturas de las tarjetas públicas de Quadis hechas con navegador.

Quadis sirve rutas semánticas para algunos modelos, pero su filtro de Audi A4
necesita query string y ``robots.txt`` desautoriza ``/*?`` para crawlers. Por eso
la fuente usa ``access: browser`` y este módulo solo procesa una captura JSON:
la navegación y la normalización quedan separadas y son reproducibles.
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

from config import ConfigError, load_runtime_config

ROOT = Path(__file__).resolve().parent.parent
DEALER = "quadis"
BASE = "https://www.quadis.es"

FUEL_MAP = {
    "diesel": "diesel",
    "gasolina": "petrol",
    "hibrido": "hybrid",
    "hibrido enchufable": "plugin_hybrid",
    "electrico": "electric",
    "glp": "lpg",
}

TRANSMISSION_MAP = {
    "manual": "manual",
    "automatico": "automatic",
    "automatica": "automatic",
}


def _ascii(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    return "".join(char for char in text if not unicodedata.combining(char)).strip().casefold()


def _integer(value: Any) -> int | None:
    digits = re.sub(r"\D", "", str(value or ""))
    return int(digits) if digits else None


def _slug(value: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", _ascii(value))).strip("-")


def _matches_target(target: dict[str, Any], card: dict[str, Any]) -> bool:
    haystack = _ascii(" ".join(str(card.get(key) or "") for key in ("n", "t", "u")))
    model = _ascii(target["model"])
    if model == "a4 allroad quattro":
        return bool(re.search(r"\ba4\b", haystack)) and "allroad" in haystack
    if model == "a3":
        return bool(re.search(r"\ba3\b", haystack))
    if model == "clase a":
        return "clase a" in haystack
    return model in haystack


def _fields(card: dict[str, Any]) -> dict[str, Any]:
    details = [str(value).strip() for value in card.get("d", []) if str(value).strip()]
    year_label = next((value for value in details if re.fullmatch(r"(?:19|20)\d{2}", value)), None)
    km_label = next(
        (value for value in details if re.search(r"\bkm\b", value, re.IGNORECASE)), None
    )
    transmission_label = next(
        (value for value in details if _ascii(value) in TRANSMISSION_MAP), None
    )
    condition_label = _ascii(card.get("c"))
    if "nuevo" in condition_label:
        condition = "new"
    elif "km0" in condition_label or "gerencia" in condition_label:
        condition = "km0"
    else:
        condition = "used"
    return {
        "year": _integer(year_label),
        "mileage_km": _integer(km_label),
        "transmission": TRANSMISSION_MAP.get(_ascii(transmission_label)),
        "condition": condition,
    }


def normalize(
    target: dict[str, Any], card: dict[str, Any], scraped_at: str
) -> dict[str, Any] | None:
    if not card.get("u") or not _matches_target(target, card):
        return None
    fields = _fields(card)
    price = _integer(card.get("p"))
    year = fields["year"]
    if price is None or year is None:
        return None
    original_price = _integer(card.get("o"))
    if original_price is not None and original_price <= price:
        original_price = None
    name = " ".join(str(card.get("n") or target["label"]).split())
    trim = " ".join(str(card.get("t") or "").split())
    power_match = re.search(r"(\d{2,4})\s*CV\b", trim, re.IGNORECASE)
    return {
        "url": card["u"],
        "title": f"{name} {trim} ({year})".strip(),
        "price": price,
        "original_price": original_price,
        "dealer_name": "Quadis",
        "dealer_website": BASE,
        "dealer_city": None,
        "dealer_country": "ES",
        "make": target["make"],
        "model": target["model"],
        "trim": trim[:120],
        "currency": "EUR",
        "external_id": str(card.get("id") or card["u"].rstrip("/").rsplit("/", 1)[-1]),
        "source": DEALER,
        "year": year,
        "mileage_km": fields["mileage_km"],
        "power_hp": int(power_match.group(1)) if power_match else None,
        "condition": fields["condition"],
        "fuel_type": FUEL_MAP.get(_ascii(card.get("f")), "other"),
        "transmission": fields["transmission"],
        "location": None,
        "image_url": card.get("i"),
        "raw": {
            "scraped_at": scraped_at,
            "dealer": DEALER,
            "selection_rule": "source order; strict target match; quantity first",
            "model_label": card.get("n"),
            "fuel_label": card.get("f"),
            "condition_label": card.get("c"),
            "details": card.get("d", []),
            "prices": {"cash": price, "previous": original_price},
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
    cards = target_data.get("candidates", [])
    by_url: dict[str, dict[str, Any]] = {}
    for card in cards:
        offer = normalize(target, card, snapshot["scraped_at"])
        if offer is not None:
            by_url.setdefault(offer["url"], offer)
    offers = list(by_url.values())
    for offer in offers:
        offer["raw"]["selection_pool"] = len(offers)
    return {
        "dealer": DEALER,
        "target": label,
        "url": target_data["url"],
        "listing_count": target_data.get("listing_count"),
        "cards_seen": len(cards),
        "offers": offers[:max_per_target],
        "reserved": [],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Normaliza una captura browser de Quadis")
    parser.add_argument(
        "--snapshot",
        type=Path,
        default=ROOT / "state" / "quadis-browser-candidates.json",
    )
    parser.add_argument("--fixture", type=Path)
    parser.add_argument("--out-dir", type=Path, default=ROOT / "state")
    parser.add_argument("--max", type=int)
    parser.add_argument("--config", type=Path)
    args = parser.parse_args()

    snapshot = json.loads(args.snapshot.read_text("utf-8"))
    args.out_dir.mkdir(parents=True, exist_ok=True)
    if args.fixture:
        args.fixture.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(args.snapshot, args.fixture)

    runtime = load_runtime_config(args.config)
    active = {
        target["label"].casefold(): target
        for target in runtime["targets"]
        if target["source"]["key"] == DEALER
    }
    for snapshot_label in snapshot["targets"]:
        config = active.get(snapshot_label.casefold())
        if config is None:
            raise ValueError(f"{snapshot_label}: no está activo en la configuración de la API")
        limit = args.max or config["max_results"]
        result = build(snapshot, config, limit, snapshot_label)
        path = args.out_dir / f"raw-quadis-{_slug(config['label'])}.json"
        path.write_text(json.dumps(result, ensure_ascii=False, indent=1), "utf-8")
        print(f"{config['label']}: {len(result['offers'])}/{limit} ofertas -> {path}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ConfigError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc
