"""Validacion, deduplicacion contra `state/seen.json` y envio a la API.

Es la mitad determinista del run diario que no depende del dealer: los extractores
de `scrapers/{dealer}.py` producen payloads de OfferIngest y este modulo decide
cuales se envian, los manda en lotes y solo entonces persiste el estado.

Orden de operaciones (importa, y es el de SKILL.md secciones 4-6):

  1. validar cada anuncio por separado
  2. freno de emergencia por target: >40% descartes, o 0 resultados cuando el run
     anterior dio >3  ->  no se envia NADA de ese target (`layout_changed`)
  3. clasificar contra seen.json: new / price_changed / unchanged / delisted
  4. escribir logs/payload-FECHA.json ANTES del POST
  5. POST en lotes de 25, con reintentos solo para 5xx/timeout
  6. escribir seen.json de forma atomica SOLO tras un 2xx

Uso:
    NR_API_KEY=... python3 scrapers/ingest.py state/raw-*.json
    NR_API_KEY=... python3 scrapers/ingest.py --dry-run state/raw-*.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
SEEN_PATH = ROOT / "state" / "seen.json"
FAILED_DIR = ROOT / "state" / "failed"
LOGS_DIR = ROOT / "logs"

PRICE_RANGE = (500, 300_000)
MILEAGE_RANGE = (0, 900_000)
YEAR_MIN = 1990
BATCH_SIZE = 25
BACKOFF_S = (2, 4, 8)
STATE_TTL_DAYS = 90
DISCARD_RATIO_BRAKE = 0.40


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------- #
# 1. Validacion
# --------------------------------------------------------------------------- #
def validate(offer: dict[str, Any], year_max: int) -> str | None:
    """Devuelve el motivo del descarte, o None si la oferta es valida."""
    if not offer.get("url"):
        return "sin url"
    price, year, km = offer.get("price"), offer.get("year"), offer.get("mileage_km")
    if price is None:
        return "sin precio"
    if year is None:
        return "sin año"
    if not PRICE_RANGE[0] <= price <= PRICE_RANGE[1]:
        return f"precio fuera de rango ({price})"
    if not YEAR_MIN <= year <= year_max:
        return f"año fuera de rango ({year})"
    if km is not None and not MILEAGE_RANGE[0] <= km <= MILEAGE_RANGE[1]:
        return f"km fuera de rango ({km})"
    return None


def content_hash(offer: dict[str, Any]) -> str:
    """Huella de los campos que, si cambian, hacen que la oferta ya no sea la misma."""
    material = [
        offer.get("title"), offer.get("price"), offer.get("original_price"),
        offer.get("mileage_km"), offer.get("year"), offer.get("dealer_name"),
        offer.get("fuel_type"), offer.get("transmission"),
    ]
    return hashlib.sha256(json.dumps(material, sort_keys=True, default=str).encode()).hexdigest()[:16]


# --------------------------------------------------------------------------- #
# Estado
# --------------------------------------------------------------------------- #
def load_seen() -> dict[str, dict[str, Any]]:
    if not SEEN_PATH.exists():
        return {}
    return json.loads(SEEN_PATH.read_text("utf-8"))


def write_seen_atomic(seen: dict[str, dict[str, Any]]) -> None:
    """Fichero temporal + os.replace: nunca deja un seen.json a medio escribir."""
    SEEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = SEEN_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(seen, ensure_ascii=False, indent=1, sort_keys=True), "utf-8")
    os.replace(tmp, SEEN_PATH)


def purge_stale(seen: dict[str, dict[str, Any]], now: datetime) -> list[str]:
    cutoff = now - timedelta(days=STATE_TTL_DAYS)
    stale = []
    for url, rec in list(seen.items()):
        try:
            last = datetime.fromisoformat(rec["last_seen"])
        except (KeyError, ValueError):
            continue
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        if last < cutoff:
            stale.append(url)
            del seen[url]
    return stale


# --------------------------------------------------------------------------- #
# 6. Envio
# --------------------------------------------------------------------------- #
def post_batch(api_base: str, api_key: str, offers: list[dict[str, Any]]) -> dict[str, Any]:
    """POST /api/v1/offers/bulk. Reintenta 5xx/timeout; un 4xx aborta sin reintentar."""
    url = f"{api_base.rstrip('/')}/api/v1/offers/bulk"
    body = json.dumps({"offers": offers}, ensure_ascii=False, default=str).encode()

    for attempt in range(len(BACKOFF_S) + 1):
        req = urllib.request.Request(url, data=body, method="POST", headers={
            "Content-Type": "application/json",
            "X-API-Key": api_key,
        })
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return {"ok": True, "status": resp.status, "body": json.loads(resp.read() or b"{}")}
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:4000]
            if 400 <= exc.code < 500:
                # 4xx: el payload o la key son el problema; reintentar no arregla nada.
                return {"ok": False, "status": exc.code, "body": detail, "retryable": False}
            if attempt == len(BACKOFF_S):
                return {"ok": False, "status": exc.code, "body": detail, "retryable": True}
            time.sleep(BACKOFF_S[attempt])
        except (urllib.error.URLError, TimeoutError) as exc:
            if attempt == len(BACKOFF_S):
                return {"ok": False, "status": None, "body": str(exc), "retryable": True}
            time.sleep(BACKOFF_S[attempt])
    return {"ok": False, "status": None, "body": "inalcanzable", "retryable": True}


def save_failed(payload: list[dict[str, Any]], response: dict[str, Any], stamp: str) -> Path:
    FAILED_DIR.mkdir(parents=True, exist_ok=True)
    path = FAILED_DIR / f"{stamp}.json"
    path.write_text(json.dumps(
        {"response": response, "offers": payload}, ensure_ascii=False, indent=1, default=str
    ), "utf-8")
    return path


# --------------------------------------------------------------------------- #
# Orquestacion
# --------------------------------------------------------------------------- #
def run(raw_files: list[Path], api_base: str, api_key: str, dry_run: bool = False) -> dict[str, Any]:
    now = utcnow()
    now_iso = now.isoformat(timespec="seconds")
    year_max = now.year + 1
    seen = load_seen()
    first_run = not seen

    targets: list[dict[str, Any]] = []
    to_send: list[dict[str, Any]] = []
    seen_urls_this_run: set[str] = set()

    for path in raw_files:
        raw = json.loads(path.read_text("utf-8"))
        offers, reserved = raw["offers"], raw.get("reserved", [])
        prev_count = sum(1 for r in seen.values() if r.get("target_key") == f"{raw['dealer']}|{raw['target']}")

        valid, discarded = [], []
        for offer in offers:
            reason = validate(offer, year_max)
            (discarded if reason else valid).append({"offer": offer, "reason": reason})
        valid = [item["offer"] for item in valid]

        found = len(offers)
        ratio = len(discarded) / found if found else 0.0
        # Freno de emergencia: casi siempre significa "cambio el HTML", no "se acabo el stock".
        brake = None
        if found and ratio > DISCARD_RATIO_BRAKE:
            brake = f"{ratio:.0%} de descartes (> {DISCARD_RATIO_BRAKE:.0%})"
        elif found == 0 and prev_count > 3:
            brake = f"0 resultados y el run anterior dio {prev_count}"

        entry = {
            "dealer": raw["dealer"], "target": raw["target"], "status": "ok",
            "found": found, "listing_count": raw.get("listing_count"),
            "reserved_excluded": len(reserved),
            "discarded": [{"url": d["offer"].get("url"), "reason": d["reason"]} for d in discarded],
            "new": [], "price_changed": [], "unchanged": [], "delisted": [],
        }

        if brake:
            entry["status"] = "layout_changed"
            entry["brake"] = brake
            targets.append(entry)
            continue

        for offer in valid:
            url = str(offer["url"])
            seen_urls_this_run.add(url)
            prev = seen.get(url)
            if prev is None:
                entry["new"].append(url)
                to_send.append(offer)
            elif prev.get("price") != offer["price"]:
                entry["price_changed"].append({
                    "url": url, "old": prev.get("price"), "new": offer["price"],
                    "delta": offer["price"] - prev["price"],
                    "pct": round((offer["price"] - prev["price"]) / prev["price"] * 100, 2) if prev.get("price") else None,
                })
                to_send.append(offer)
            else:
                entry["unchanged"].append(url)

        # Delisted: lo conocido de ESTE target que hoy no ha aparecido.
        target_key = f"{raw['dealer']}|{raw['target']}"
        for url, rec in seen.items():
            if rec.get("target_key") == target_key and url not in seen_urls_this_run:
                entry["delisted"].append(url)

        targets.append(entry)

    # 4. El payload se deja en disco ANTES del POST, para poder reenviarlo a mano.
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    payload_path = LOGS_DIR / f"payload-{now:%Y-%m-%d}.json"
    # Un segundo run el mismo dia no puede pisar el payload del primero: es la copia
    # con la que se reenvia a mano si algo se rompe.
    if payload_path.exists():
        payload_path = LOGS_DIR / f"payload-{now:%Y-%m-%dT%H%M%SZ}.json"
    payload_path.write_text(json.dumps(
        {"generated_at": now_iso, "api_base": api_base, "offers": to_send},
        ensure_ascii=False, indent=1, default=str,
    ), "utf-8")

    result = {
        "targets": targets, "payload_path": str(payload_path.relative_to(ROOT)),
        "sent": 0, "batches": [], "aborted": False, "first_run": first_run,
        "purged": [], "dry_run": dry_run,
    }

    if dry_run:
        result["note"] = "dry-run: no se ha hecho POST ni se ha tocado seen.json"
        return result

    accepted: list[dict[str, Any]] = []
    for i in range(0, len(to_send), BATCH_SIZE):
        batch = to_send[i:i + BATCH_SIZE]
        response = post_batch(api_base, api_key, batch)
        result["batches"].append({
            "size": len(batch), "status": response["status"],
            "ok": response["ok"], "body": response["body"],
        })
        if response["ok"]:
            accepted.extend(batch)
            result["sent"] += len(batch)
            continue
        stamp = f"{now:%Y%m%dT%H%M%SZ}-batch{i // BATCH_SIZE + 1}"
        result["batches"][-1]["failed_payload"] = str(save_failed(batch, response, stamp).relative_to(ROOT))
        if response["status"] == 401:
            # Key mala o caducada: no tiene sentido seguir.
            result["aborted"] = "401 en la API: key invalida o caducada"
            break
        if not response.get("retryable"):
            break

    # 6. Solo lo que la API acepto entra en el estado. Lo demas se reintenta manana.
    accepted_urls = {str(o["url"]) for o in accepted}
    by_url = {str(o["url"]): o for o in to_send}
    for entry in result["targets"]:
        if entry["status"] != "ok":
            continue
        target_key = f"{entry['dealer']}|{entry['target']}"
        for url in entry["unchanged"]:
            seen.setdefault(url, {"price": by_url.get(url, {}).get("price"), "first_seen": now_iso})
            seen[url]["last_seen"] = now_iso
            seen[url]["target_key"] = target_key
        # Solo las URLs de ESTE target: si se recorriese accepted_urls entera, el
        # target_key de todas las ofertas acabaria siendo el del ultimo target.
        for url in entry["new"] + [pc["url"] for pc in entry["price_changed"]]:
            if url not in accepted_urls:
                continue  # la API no la acepto: que la reintente el run de manana
            offer = by_url[url]
            rec = seen.get(url) or {"first_seen": now_iso}
            rec.update({
                "price": offer["price"], "last_seen": now_iso,
                "content_hash": content_hash(offer), "target_key": target_key,
            })
            rec.setdefault("first_seen", now_iso)
            seen[url] = rec

    result["purged"] = purge_stale(seen, now)
    if accepted or any(e["unchanged"] for e in result["targets"]):
        write_seen_atomic(seen)
        result["state_written"] = True
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description="Valida, deduplica y envia ofertas a la API")
    ap.add_argument("raw", nargs="+", type=Path, help="salidas JSON de los extractores")
    ap.add_argument("--api-base", default=None)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--out", type=Path, help="donde escribir el resumen del run")
    args = ap.parse_args()

    api_base = (
        args.api_base
        or os.environ.get("NR_API_BASE_URL")
        or "http://localhost:8000"
    )
    api_key = os.environ.get("NR_API_KEY", "")
    if not api_key and not args.dry_run:
        print("ERROR: falta NR_API_KEY", file=sys.stderr)
        return 2

    result = run(args.raw, api_base, api_key, dry_run=args.dry_run)
    text = json.dumps(result, ensure_ascii=False, indent=1, default=str)
    if args.out:
        args.out.write_text(text, "utf-8")
    print(text)
    return 1 if result.get("aborted") else 0


if __name__ == "__main__":
    raise SystemExit(main())
