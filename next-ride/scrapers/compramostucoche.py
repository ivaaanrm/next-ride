"""Extractor determinista de Compramos Tu Coche (access: fetch).

El listado publico de https://www.compramostucoche.es/comprar-coche/ se renderiza
en servidor, asi que basta `fetch`. Las clases CSS son CSS-modules con hash
(`root___Dz4kU`) y cambian en cada despliegue: **no sirven como selector**. Lo
estable son los atributos `data-qa-selector`, que es lo unico que lee este modulo.

El anuncio vive en compramostucoche.es pero el enlace apunta a autohero.com, que
es la marca de retail del mismo grupo (AUTO1) y el vendedor real. Por eso
`dealer_name` es Autohero y la URL canonica es la de autohero.com sin el `MID`
de tracking.

Vocabulario de marca y modelo (la trampa de este sitio)
-------------------------------------------------------
Los parametros `brand` y `model` NO usan el nombre que muestra la interfaz:

    brand   guion bajo donde el nombre lleva guion:  MERCEDES_BENZ, no MERCEDES-BENZ
    model   `{BRAND}.{TOKEN}` con el token interno, que esta en aleman:
            MERCEDES_BENZ.A-KLASSE, no MERCEDES_BENZ.CLASE A
            MITSUBISHI.PAJERO,      no MITSUBISHI.MONTERO

Y lo peligroso: **un token invalido no da error**. El sitio responde HTTP 200 y
devuelve el catalogo entero sin filtrar, asi que una consulta rota parece un
listado sano lleno de coches de otras marcas. La unica senal fiable es el chip de
filtro activo (`data-qa-selector="filter-item-vehicle"`): si no esta, el filtro se
ha ignorado. `assert_filter_applied()` corta ahi, tal y como pide SKILL.md 2.2.

Cada variante de carroceria es un modelo aparte y el sitio no acepta varios
`model` en la misma URL (repetir el parametro se queda con el primero). Por eso un
target lleva una lista de tokens en `search_params.model_tokens` y se recorren en
orden hasta completar el cupo.

Precios: `data-qa-selector="price"` trae el contado ya en entero dentro de
`data-qa-selector-value`. `monthly-price` es la cuota financiada y **no se usa**.

Uso:
    python3 scrapers/compramostucoche.py "Audi A3" --max 15 \
      --config state/runtime-config.json \
      --fixture scrapers/fixtures/compramostucoche-audi-a3-listing.html \
      --out state/raw-compramostucoche-audi-a3.json
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from config import ConfigError, find_target

ROOT = Path(__file__).resolve().parent.parent
DEALER_ID = "compramostucoche"
BASE = "https://www.compramostucoche.es"
SEARCH_PATH = "/comprar-coche/"
SELLER_NAME = "Autohero"
SELLER_SITE = "https://www.autohero.com"
USER_AGENT = "Mozilla/5.0 (compatible; NextRideResearch/1.0)"
REQUEST_DELAY_S = 2.0
TIMEOUT_S = 40
MAX_PAGES_PER_TOKEN = 3
PAGE_SIZE = 10
# El sitio sirve una imagen de relleno hasta que el carrusel carga por JS.
PLACEHOLDER_IMAGE = re.compile(r"/images/default(Tablet|Mobile|Desktop)Image", re.I)

FUEL_MAP = {
    "diesel": "diesel",
    "gasolina": "petrol",
    "hibrido": "hybrid",
    "hibrido enchufable": "plugin_hybrid",
    "electrico": "electric",
    "glp": "lpg",
    "gnc": "other",
}

TRANSMISSION_MAP = {
    "manual": "manual",
    "automatico": "automatic",
    "automatica": "automatic",
}

_last_request_at = 0.0


class ExtractorError(RuntimeError):
    """La respuesta publica ya no tiene la forma esperada."""


def _throttle() -> None:
    global _last_request_at
    wait = REQUEST_DELAY_S - (time.monotonic() - _last_request_at)
    if wait > 0:
        time.sleep(wait)
    _last_request_at = time.monotonic()


def _ascii(value: str) -> str:
    return unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()


def _norm(value: str) -> str:
    """Compara etiquetas ignorando acentos, guiones y espacios de mas."""

    return " ".join(re.sub(r"[-_]+", " ", _ascii(str(value or ""))).casefold().split())


def _text(fragment: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", " ", fragment)).strip()


def _digits(value: str) -> int | None:
    found = re.sub(r"\D", "", value or "")
    return int(found) if found else None


def search_url(brand: str, token: str, page: int = 1) -> str:
    params = {
        "brand": brand,
        "model": f"{brand}.{token}",
        "sort": "STANDARD_PRICE_ASC",
    }
    if page > 1:
        params["page"] = str(page)
    query = urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
    return f"{BASE}{SEARCH_PATH}?{query}"


def fetch_html(url: str) -> str:
    _throttle()
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "es-ES,es;q=0.9",
        },
    )
    with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
        return response.read().decode("utf-8", "replace")


def active_filter_chips(page: str) -> list[str]:
    return [
        _text(block)
        for block in re.findall(
            r'data-qa-selector="filter-item-vehicle"[^>]*>(.*?)</div>', page, re.S
        )
    ]


def assert_filter_applied(page: str, brand_label: str, token: str, url: str) -> str:
    """SKILL.md 2.2: sin asercion de contenido, un 200 no significa nada aqui.

    Un `model` invalido devuelve el catalogo completo con HTTP 200 y sin ningun
    aviso. Se exige que exista el chip del filtro y que su parte de modelo
    coincida exactamente con el token pedido; asi un token que el sitio ignore o
    reinterprete no se cuela como si fuera stock del target.
    """

    chips = active_filter_chips(page)
    if not chips:
        raise ExtractorError(
            f"el filtro se ignoro (sin chip activo) en {url}; "
            f"token {token!r} no valido para {brand_label!r}"
        )
    wanted = _norm(token)
    for chip in chips:
        model_part = _norm(chip)
        prefix = _norm(brand_label)
        if model_part.startswith(prefix):
            model_part = model_part[len(prefix):].strip()
        if model_part == wanted:
            return chip
    raise ExtractorError(
        f"el chip activo {chips!r} no corresponde al token {token!r} en {url}"
    )


def split_cards(page: str) -> list[str]:
    """Trocea el listado por tarjeta.

    El cierre del `<ul>` no es fiable con anidamiento, asi que la ultima tarjeta
    termina en el primer marcador posterior que ya no pertenece al listado.
    """

    marker = 'data-qa-selector="ad-item"'
    starts = [match.start() for match in re.finditer(re.escape(marker), page)]
    if not starts:
        return []
    tail_markers = ('<ul class="pagination', 'data-qa-selector="favorites-link"',
                    'data-qa-selector="sidebar-filters"')
    candidates = [page.find(m, starts[-1]) for m in tail_markers]
    end = min([pos for pos in candidates if pos > 0], default=len(page))
    bounds = starts + [end]
    return [page[bounds[i]: bounds[i + 1]] for i in range(len(starts))]


def _field(card: str, selector: str) -> str:
    match = re.search(
        r'data-qa-selector="%s"[^>]*>(.*?)</(?:li|div|span|b|a)>' % re.escape(selector),
        card,
        re.S,
    )
    return _text(match.group(1)) if match else ""


def _qa_value(card: str, selector: str) -> str | None:
    match = re.search(
        r'<[^>]*data-qa-selector-value="([^"]*)"[^>]*data-qa-selector="%s"' % re.escape(selector),
        card,
    )
    if match:
        return match.group(1)
    match = re.search(
        r'<[^>]*data-qa-selector="%s"[^>]*data-qa-selector-value="([^"]*)"' % re.escape(selector),
        card,
    )
    return match.group(1) if match else None


def _canonical_url(raw_url: str) -> str:
    """Quita el `MID` de tracking; la URL limpia es la clave natural de la oferta."""

    split = urllib.parse.urlsplit(html.unescape(raw_url))
    return urllib.parse.urlunsplit((split.scheme, split.netloc, split.path, "", ""))


def _external_id(url: str) -> str | None:
    match = re.search(r"/id/([0-9a-f-]{16,})", url)
    return match.group(1) if match else None


def _year(registration: str) -> int | None:
    match = re.search(r"(\d{4})", registration or "")
    return int(match.group(1)) if match else None


def _power_hp(label: str) -> int | None:
    match = re.search(r"\((\d+)\s*CV\)", label or "")
    return int(match.group(1)) if match else None


def _image(card: str) -> str | None:
    """La foto real la carga el carrusel por JS.

    En el HTML servido solo hay relleno: una imagen `defaultTabletImage` o un
    `data:` en base64 de 1x1. Ninguno identifica al coche y el segundo ademas
    desbordaria el limite de 1000 caracteres de `image_url`, asi que con `fetch`
    este campo se queda vacio a proposito.
    """

    for match in re.finditer(r'<img[^>]*src="([^"]+)"', card):
        url = html.unescape(match.group(1))
        if url.startswith("data:") or PLACEHOLDER_IMAGE.search(url):
            continue
        return url
    return None


def _trim(title: str, make: str, model: str) -> str:
    for prefix in (f"{make} {model}", make):
        if title.casefold().startswith(prefix.casefold()):
            return title[len(prefix):].strip()[:120]
    return title[:120]


def normalize(card: str, make: str, model: str, scraped_at: str) -> dict[str, Any] | None:
    link = re.search(r'data-qa-selector="title"[^>]*href="([^"]+)"', card)
    title_text = _field(card, "title")
    if not link or not title_text:
        # Hueco publicitario o tarjeta sin enlace: se descarta al normalizar.
        return None

    url = _canonical_url(link.group(1))
    registration = _field(card, "registration")
    year = _year(registration)
    price = _digits(_qa_value(card, "price") or _field(card, "price"))
    fuel_label = _field(card, "fuelType")
    transmission_label = _field(card, "transmission")

    return {
        "url": url,
        "title": f"{title_text} ({year})" if year else title_text,
        "price": price,
        "original_price": None,
        "dealer_name": SELLER_NAME,
        "dealer_website": SELLER_SITE,
        "dealer_city": None,
        "dealer_country": "ES",
        "make": make,
        "model": model,
        "trim": _trim(title_text, make, model),
        "currency": "EUR",
        "external_id": _external_id(url),
        "source": DEALER_ID,
        "year": year,
        "mileage_km": _digits(_field(card, "mileage")),
        "power_hp": _power_hp(_field(card, "horsePower")),
        "condition": "used",
        "fuel_type": FUEL_MAP.get(_norm(fuel_label), "other"),
        "transmission": TRANSMISSION_MAP.get(_norm(transmission_label), "other"),
        "location": None,
        "image_url": _image(card),
        "raw": {
            "scraped_at": scraped_at,
            "dealer": DEALER_ID,
            "listed_on": BASE,
            "registration": registration,
            "fuel_label": fuel_label,
            "transmission_label": transmission_label,
            "monthly_price_ignored": _qa_value(card, "monthly-price"),
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
    params = dealer_cfg.get("search_params") or {}
    brand = str(params.get("brand") or "").strip()
    tokens = [str(token) for token in params.get("model_tokens") or [] if str(token).strip()]
    if not brand or not tokens:
        raise ExtractorError(
            f"{target!r} necesita search_params.brand y search_params.model_tokens"
        )
    brand_label = brand.replace("_", "-").casefold().title()

    scraped_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    offers: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    cards_seen = 0
    pages_read = 0
    per_token: list[dict[str, Any]] = []
    fixture_saved = False

    for token in tokens:
        token_found = 0
        chip = ""
        for page in range(1, MAX_PAGES_PER_TOKEN + 1):
            url = search_url(brand, token, page)
            body = fetch_html(url)
            pages_read += 1
            chip = assert_filter_applied(body, brand_label, token, url)

            if save_fixture and not fixture_saved:
                save_fixture.parent.mkdir(parents=True, exist_ok=True)
                save_fixture.write_text(body, "utf-8")
                fixture_saved = True

            cards = split_cards(body)
            cards_seen += len(cards)
            for card in cards:
                offer = normalize(card, make, model, scraped_at)
                if offer is None or offer["url"] in seen_urls:
                    continue
                seen_urls.add(offer["url"])
                offers.append(offer)
                token_found += 1
            if len(offers) >= max_per_target or len(cards) < PAGE_SIZE:
                break
        per_token.append({"token": token, "chip": chip, "offers": token_found})
        if len(offers) >= max_per_target:
            break

    selected = offers[:max_per_target]
    for offer in selected:
        offer["raw"]["selection_pool"] = len(offers)
        offer["raw"]["selection_rule"] = "source order; quantity first"

    return {
        "dealer": DEALER_ID,
        "target": target,
        "url": search_url(brand, tokens[0]),
        "listing_count": len(offers),
        "source_listing_count": len(offers),
        "cards_seen": cards_seen,
        "pages_read": pages_read,
        "model_tokens": per_token,
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
    parser = argparse.ArgumentParser(description="Extractor de Compramos Tu Coche")
    parser.add_argument("target", help='p. ej. "Audi A3"')
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
