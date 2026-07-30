"""Extractor determinista para Flexicar (access: fetch).

Flexicar es una app Next.js que renderiza en servidor: la primera página embute
el estado en `<script id="__NEXT_DATA__">` y las siguientes llegan desde el
endpoint público que usa su scroll infinito. No hace falta parsear selectores CSS.
Las rutas de datos son:

    primera página: props.pageProps.initialVehicles[] (+ countVehicles)
    páginas 2-3:    source.config.vehicles_api_url -> results[] (+ total)
    ficha:   props.pageProps.vehicle{}, props.pageProps.dealership{}

Semantica de precios (importante, es la trampa de este sitio)
-------------------------------------------------------------
Cada vehiculo trae cuatro numeros distintos:

    price          precio FINANCIADO (el numero grande de la tarjeta)
    cashPrice      precio de CONTADO  <-- es el que manda
    previousPrice  precio tachado junto al financiado; en la practica == cashPrice
    quotaPrice     cuota mensual      <-- nunca usar
    retailPrice    PVP del coche a nuevo, irrelevante para una oferta de ocasion

`SKILL.md` pide el precio de contado, luego mapeamos price <- cashPrice. Y como
previousPrice coincide con cashPrice (no es un "antes" real, es el contado frente
al financiado), original_price se queda en None en vez de fabricar un descuento
del 0%. Si algun dia previousPrice > cashPrice de verdad, este extractor lo
publicara como original_price sin tocar nada mas.

La configuración de la API avisa de que la tarjeta del listado y la ficha pueden discrepar en
el precio de contado, y que manda la ficha: por eso `extract()` visita la ficha de
cada anuncio y usa su cashPrice. La ficha aporta ademas `hp` y la poblacion de la
delegacion, que en el listado no vienen.

Uso:
    python3 scrapers/flexicar.py "Audi A4 Allroad quattro" --max 10 --out out.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.request
import urllib.robotparser
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from config import ConfigError, find_target

ROOT = Path(__file__).resolve().parent.parent
DEALER_ID = "flexicar"
BASE = "https://www.flexicar.es"
DETAIL_PREFIX = f"{BASE}/coches-ocasion/"

USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
REQUEST_DELAY_S = 2.0  # SKILL.md: maximo 1 request cada 2 segundos por dominio
TIMEOUT_S = 40

_NEXT_DATA_RE = re.compile(
    r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', re.S
)

# Los portales no se ponen de acuerdo en como llamar al combustible, y el enum de
# la API (app.models.offer.FuelType) no usa exactamente las etiquetas de SKILL.md:
# la API dice `petrol` (no `gasoline`) y `plugin_hybrid` (no `phev`), y no tiene
# `cng`. Manda el enum de la API, que es quien valida el POST.
FUEL_MAP = {
    "diesel": "diesel",
    "diésel": "diesel",
    "gasolina": "petrol",
    "hibrido no enchufable": "hybrid",
    "híbrido no enchufable": "hybrid",
    "hev": "hybrid",
    "mhev": "hybrid",
    "mild hybrid": "hybrid",
    "hibrido enchufable": "plugin_hybrid",
    "híbrido enchufable": "plugin_hybrid",
    "phev": "plugin_hybrid",
    "electrico": "electric",
    "eléctrico": "electric",
    "glp": "lpg",
    "gnc": "other",  # la API no tiene `cng`
}

TRANSMISSION_MAP = {
    "automatica": "automatic",
    "automática": "automatic",
    "manual": "manual",
}

_last_request_at = 0.0


class ExtractorError(RuntimeError):
    """El HTML no tiene la forma esperada: hay que comparar con el fixture."""


def _throttle() -> None:
    global _last_request_at
    wait = REQUEST_DELAY_S - (time.monotonic() - _last_request_at)
    if wait > 0:
        time.sleep(wait)
    _last_request_at = time.monotonic()


def fetch(url: str) -> str:
    _throttle()
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "es-ES,es;q=0.9",
        },
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        return resp.read().decode("utf-8", "replace")


def fetch_json(url: str) -> dict[str, Any]:
    _throttle()
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
            "Accept-Language": "es-ES,es;q=0.9",
        },
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        try:
            payload = json.loads(resp.read().decode("utf-8", "replace"))
        except json.JSONDecodeError as exc:
            raise ExtractorError("la API de vehículos no devolvió JSON válido") from exc
    if not isinstance(payload, dict):
        raise ExtractorError("la API de vehículos devolvió una raíz que no es un objeto")
    return payload


_robots_cache: dict[str, urllib.robotparser.RobotFileParser] = {}


def robots_allows(url: str) -> bool:
    """SKILL.md: con `fetch` manda robots.txt, y el host de la API es otro dominio.

    `services.flexicar.es/robots.txt` publica `Disallow: /`, asi que la paginacion
    por el endpoint de scroll infinito no se puede usar aunque este configurada.
    Ante un robots.txt ilegible se asume permitido, que es como lo interpreta un
    cliente HTTP normal.
    """
    parsed = urlsplit(url)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    parser = _robots_cache.get(origin)
    if parser is None:
        parser = urllib.robotparser.RobotFileParser()
        parser.set_url(f"{origin}/robots.txt")
        _throttle()
        try:
            parser.read()
        except Exception:  # noqa: BLE001 - sin robots.txt legible, se permite
            parser.allow_all = True
        _robots_cache[origin] = parser
    return parser.can_fetch(USER_AGENT, url)


def next_data(html: str) -> dict[str, Any]:
    m = _NEXT_DATA_RE.search(html)
    if not m:
        raise ExtractorError("no se encontro <script id=__NEXT_DATA__>")
    return json.loads(m.group(1))


def search_url(dealer_cfg: dict[str, Any], target: str) -> str:
    url = dealer_cfg.get("search_url")
    if not url:
        raise ExtractorError(f"la API no devolvió una URL resuelta para {target!r}")
    return str(url)


def detail_url(slug: str) -> str:
    return DETAIL_PREFIX + slug


def vehicles_page_url(
    api_url: str,
    page: int,
    size: int,
    search_params: dict[str, Any],
) -> str:
    """Construye la URL que usa el scroll infinito oficial de Flexicar."""

    parsed = urlsplit(api_url)
    reserved = {"page", "size", "brands", "models"}
    query = [(key, value) for key, value in parse_qsl(parsed.query) if key not in reserved]
    query.extend((("page", str(page)), ("size", str(size))))
    if search_params.get("make_slug"):
        query.append(("brands", str(search_params["make_slug"])))
    if search_params.get("model_slug"):
        query.append(("models", str(search_params["model_slug"])))
    return urlunsplit(
        (parsed.scheme, parsed.netloc, parsed.path, urlencode(query, doseq=True), parsed.fragment)
    )


def _norm(value: Any) -> str:
    return str(value or "").strip().lower()


def _fuel(raw: Any) -> str | None:
    return FUEL_MAP.get(_norm(raw))


def _transmission(raw: Any) -> str | None:
    return TRANSMISSION_MAP.get(_norm(raw))


def _condition(km: Any) -> str:
    """Flexicar no publica un campo de estado; se deduce del kilometraje."""
    try:
        return "km0" if int(km) <= 100 else "used"
    except (TypeError, ValueError):
        return "used"


def _external_id(vehicle: dict[str, Any], url: str) -> str:
    vid = vehicle.get("id")
    if vid:
        return str(vid)
    return hashlib.sha256(url.encode()).hexdigest()[:32]


def normalize(
    card: dict[str, Any],
    detail: dict[str, Any] | None,
    dealership: dict[str, Any] | None,
    target_make: str,
    target_model: str,
    scraped_at: str,
) -> dict[str, Any]:
    """Convierte un vehiculo de Flexicar en el payload de OfferIngest."""
    v = {**card, **(detail or {})}  # la ficha pisa a la tarjeta: manda la ficha
    dealership = dealership or {}
    url = detail_url(v["slug"])

    cash_price = v.get("cashPrice")
    previous = v.get("previousPrice")
    # Solo es un precio tachado de verdad si esta por encima del de contado.
    original_price = previous if (cash_price and previous and previous > cash_price) else None

    delegation = v.get("carDealership") or dealership.get("name")
    dealer_name = f"Flexicar {delegation}".strip() if delegation else "Flexicar"

    year = v.get("year")
    location_bits = [dealership.get("location"), dealership.get("province")]
    location = ", ".join(b for b in dict.fromkeys(filter(None, location_bits)))

    return {
        "url": url,
        "title": " ".join(
            p for p in [v.get("brand"), v.get("model"), v.get("version"), f"({year})" if year else None] if p
        ),
        "price": cash_price,
        "original_price": original_price,
        "dealer_name": dealer_name,
        "dealer_website": BASE,
        "dealer_city": dealership.get("location") or None,
        "dealer_country": "ES",
        "make": target_make,
        "model": target_model,
        "trim": (v.get("version") or "")[:120],
        "currency": "EUR",
        "external_id": _external_id(v, url),
        "source": DEALER_ID,
        "year": year,
        "mileage_km": v.get("km"),
        "power_hp": v.get("hp"),
        "condition": _condition(v.get("km")),
        "fuel_type": _fuel(v.get("fuel")),
        "transmission": _transmission(v.get("transmission")),
        "location": location or None,
        "image_url": v.get("image") or (v.get("images") or [None])[0],
        "raw": {
            "scraped_at": scraped_at,
            "dealer": DEALER_ID,
            "reserved": bool(v.get("reserved")),
            "fuel_label": v.get("fuel"),
            "eco_sticker": v.get("ecoSticker"),
            "color": v.get("color"),
            "outlet": v.get("outlet"),
            # Se guardan los cuatro precios para poder auditar la eleccion.
            "prices": {
                "cash": cash_price,
                "financed": v.get("price"),
                "previous": previous,
                "monthly_quota": v.get("quotaPrice"),
                "retail_new": v.get("retailPrice"),
                "card_cash_price": card.get("cashPrice"),
                "detail_cash_price": (detail or {}).get("cashPrice"),
            },
        },
    }


def extract(
    target: str,
    dealer_cfg: dict[str, Any],
    max_per_target: int = 15,
    *,
    with_detail: bool = True,
    save_fixture: Path | None = None,
) -> dict[str, Any]:
    """Devuelve {"offers": [...], "listing_count": N, "reserved": [...], "url": ...}."""
    make = str(dealer_cfg.get("make") or target.split(" ", 1)[0])
    model = str(dealer_cfg.get("model") or target.removeprefix(f"{make} ").strip())
    url = search_url(dealer_cfg, target)
    scraped_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    offers, reserved = [], []
    seen_cards: set[str] = set()
    cards_seen = 0
    robots_blocked = False
    html = fetch(url)
    if save_fixture:
        save_fixture.parent.mkdir(parents=True, exist_ok=True)
        save_fixture.write_text(html, "utf-8")

    page_props = next_data(html).get("props", {}).get("pageProps", {})
    cards = page_props.get("initialVehicles")
    if cards is None:
        raise ExtractorError("props.pageProps.initialVehicles no existe (el layout cambio)")
    listing_count = int(page_props.get("countVehicles") or 0)
    api_url = dealer_cfg.get("vehicles_api_url")
    search_params = dealer_cfg.get("search_params", {})
    has_next = listing_count > len(cards)

    for page in range(1, 4):
        if page > 1:
            if not api_url or not has_next:
                break
            page_url = vehicles_page_url(str(api_url), page, 12, search_params)
            if not robots_allows(page_url):
                print(
                    f"  aviso: {urlsplit(page_url).netloc} desautoriza esta ruta en su"
                    " robots.txt; me quedo con las tarjetas de la primera pagina",
                    file=sys.stderr,
                )
                robots_blocked = True
                break
            api_page = fetch_json(page_url)
            cards = api_page.get("results")
            if not isinstance(cards, list):
                raise ExtractorError("la API de vehículos no devolvió results[]")
            listing_count = max(listing_count, int(api_page.get("total") or 0))
            has_next = bool(api_page.get("hasNext"))

        for card in cards:
            identity = str(card.get("id") or card.get("slug") or "")
            if not identity or identity in seen_cards:
                continue
            seen_cards.add(identity)
            cards_seen += 1

            detail = dealership = None
            if with_detail:
                try:
                    dpp = next_data(fetch(detail_url(card["slug"])))["props"]["pageProps"]
                    detail, dealership = dpp.get("vehicle"), dpp.get("dealership")
                except (urllib.error.URLError, ExtractorError, KeyError, TimeoutError) as exc:
                    # La ficha es una mejora, no un requisito: seguimos con la tarjeta.
                    print(
                        f"  aviso: ficha {card.get('id')} ilegible ({exc}); uso la tarjeta",
                        file=sys.stderr,
                    )
            offer = normalize(card, detail, dealership, make, model, scraped_at)
            (reserved if offer["raw"]["reserved"] else offers).append(offer)
            if len(offers) >= max_per_target:
                break

        if len(offers) >= max_per_target or not cards:
            break
        if listing_count and len(seen_cards) >= listing_count:
            break

    return {
        "dealer": DEALER_ID,
        "target": target,
        "url": url,
        "listing_count": listing_count or cards_seen,
        "cards_seen": cards_seen,
        "pagination_blocked_by_robots": robots_blocked,
        "offers": offers,
        "reserved": reserved,
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
    ap = argparse.ArgumentParser(description="Extractor de Flexicar")
    ap.add_argument("target", help='p. ej. "Audi A4 Allroad quattro"')
    ap.add_argument("--max", type=int)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--fixture", type=Path)
    ap.add_argument("--config", type=Path)
    ap.add_argument("--no-detail", action="store_true", help="no visitar las fichas")
    args = ap.parse_args()

    dealer_cfg = load_dealer_cfg(args.target, args.config)
    result = extract(
        args.target,
        dealer_cfg,
        args.max or dealer_cfg["max_results"],
        with_detail=not args.no_detail,
        save_fixture=args.fixture,
    )
    payload = json.dumps(result, ensure_ascii=False, indent=1)
    if args.out:
        args.out.write_text(payload, "utf-8")
        print(f"{len(result['offers'])} ofertas + {len(result['reserved'])} reservadas -> {args.out}")
    else:
        print(payload)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ConfigError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc
