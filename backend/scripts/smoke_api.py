"""Smoke test end-to-end de la API contra el stack en docker compose.

    python3 backend/scripts/smoke_api.py

Se ejecuta desde el host (no dentro del contenedor) y recorre autenticación,
ingesta con API key, métricas, filtros, descarte manual y seguimiento de
modelos. Es idempotente: cada ejecución usa URLs propias.

Requiere que el stack esté arriba y con datos (`make up && make seed`).
"""

import json
import os
import urllib.error
import urllib.request
import uuid

BASE = os.environ.get("NEXTRIDE_API", "http://localhost:8000/api/v1")
EMAIL = os.environ.get("NEXTRIDE_EMAIL", "admin@next-ride.dev")
PASSWORD = os.environ.get("NEXTRIDE_PASSWORD", "changeme123")

# Sufijo único por ejecución: el upsert es por URL, así no se pisan los runs.
RUN_ID = uuid.uuid4().hex[:8]

ok = 0
fail = 0


def call(method, path, body=None, token=None, api_key=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    if api_key:
        req.add_header("X-API-Key", api_key)
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            return exc.code, json.loads(raw)
        except Exception:
            return exc.code, raw.decode(errors="replace")


def check(label, condition, detail=""):
    global ok, fail
    if condition:
        ok += 1
        print(f"  PASS  {label}" + (f"  ({detail})" if detail else ""))
    else:
        fail += 1
        print(f"  FAIL  {label}  {detail}")


print("== auth ==")
status, tok = call("POST", "/auth/login", {"email": EMAIL, "password": PASSWORD})
check("login", status == 200 and "access_token" in (tok or {}), f"HTTP {status}")
token = tok["access_token"]
refresh = tok["refresh_token"]

status, me = call("GET", "/auth/me", token=token)
check("GET /auth/me", status == 200 and me["email"] == EMAIL, f"HTTP {status}")

status, _ = call("GET", "/auth/me")
check("sin token -> 401", status == 401, f"HTTP {status}")

status, _ = call("GET", "/auth/me", token="basura.invalida.aqui")
check("token inválido -> 401", status == 401, f"HTTP {status}")

status, pair = call("POST", "/auth/refresh", {"refresh_token": refresh})
check("refresh token", status == 200 and "access_token" in (pair or {}), f"HTTP {status}")

status, _ = call("POST", "/auth/login", {"email": EMAIL, "password": "mal"})
check("password erróneo -> 401", status == 401, f"HTTP {status}")

print("\n== api keys / ingesta del scraper ==")
status, key = call("POST", "/api-keys", {"name": f"smoke-{RUN_ID}"}, token=token)
check("crear api key", status == 201 and key["api_key"].startswith("nr_"), f"HTTP {status}")
raw_key = key["api_key"]

status, listed = call("GET", "/api-keys", token=token)
check("listar api keys", status == 200 and any(k["id"] == key["id"] for k in listed))
check("hash no expuesto", all("hashed_key" not in k for k in listed))

batch = {
    "offers": [
        {
            "url": f"https://smoke.example/coche/{RUN_ID}",
            "title": "Toyota Corolla 1.8 Hybrid Active (2023)",
            "price": 22990,
            "original_price": 26500,
            "dealer_name": "Smoke Motors",
            "make": "Toyota",
            "model": "Corolla",
            "trim": "1.8 Hybrid Active",
            "year": 2023,
            "mileage_km": 11000,
            "condition": "km0",
            "fuel_type": "hybrid",
            "transmission": "automatic",
        },
        {"url": "no-es-url", "title": "roto", "price": -5, "dealer_name": "X", "make": "X", "model": "Y"},
    ]
}
status, result = call("POST", "/offers/bulk", batch, api_key=raw_key)
check(
    "bulk tolerante (1 buena + 1 rota)",
    status == 200 and result["created"] == 1 and result["skipped"] == 1,
    f"HTTP {status} creadas={result.get('created')} descartadas={result.get('skipped')}",
)
check("el error identifica la oferta", bool(result["errors"]), result["errors"][0][:70] if result["errors"] else "")

status, _ = call("POST", "/offers/bulk", {"offers": []}, api_key="nr_dead_beef")
check("api key inválida -> 401", status == 401, f"HTTP {status}")

status, _ = call("POST", "/offers/bulk", batch)
check("ingesta sin credenciales -> 401", status == 401, f"HTTP {status}")

# Upsert: misma URL, precio menor.
batch2 = {"offers": [dict(batch["offers"][0], price=21490)]}
status, result2 = call("POST", "/offers/bulk", batch2, api_key=raw_key)
check(
    "upsert por url (no duplica)",
    status == 200 and result2["updated"] == 1 and result2["created"] == 0,
    f"creadas={result2.get('created')} actualizadas={result2.get('updated')}",
)
offer_id = result2["offer_ids"][0]

status, history = call("GET", f"/offers/{offer_id}/price-history", token=token)
check("historial de precios con 2 puntos", status == 200 and len(history) == 2, f"{len(history or [])} puntos")

status, offer = call("GET", f"/offers/{offer_id}", token=token)
m = offer["metrics"]
check("price_drop_pct calculado", m["price_drop_pct"] is not None, f"{m['price_drop_pct']}%")
check("discount_pct calculado", m["discount_pct"] is not None, f"{m['discount_pct']}%")
check("vs mediana calculado", m["price_vs_median_pct"] is not None, f"{m['price_vs_median_pct']}%")
check("value_score en rango", 0 <= (m["value_score"] or -1) <= 100, str(m["value_score"]))

print("\n== ofertas: filtros y ordenación ==")
status, page = call("GET", "/offers?limit=5&sort=price", token=token)
prices = [o["price"] for o in page["items"]]
check("sort=price ascendente", status == 200 and prices == sorted(prices), str([int(p) for p in prices]))

status, page = call("GET", "/offers?limit=5&sort=-price", token=token)
prices = [o["price"] for o in page["items"]]
check("sort=-price descendente", prices == sorted(prices, reverse=True), str([int(p) for p in prices]))

status, page = call("GET", "/offers?limit=200&sort=value_score", token=token)
scores = [o["metrics"]["value_score"] for o in page["items"]]
check("sort=value_score descendente", scores == sorted(scores, reverse=True))

status, page = call("GET", "/offers?limit=200&sort=ai_score", token=token)
check("sort=ai_score responde sin rankings", status == 200, f"{len(page['items'])} ofertas")

status, page = call("GET", "/offers?max_price=25000&limit=100", token=token)
check("filtro max_price", status == 200 and all(o["price"] <= 25000 for o in page["items"]),
      f"{len(page['items'])} ofertas")

status, page = call("GET", "/offers?condition=km0&limit=100", token=token)
check("filtro condition", all(o["condition"] == "km0" for o in page["items"]), f"{len(page['items'])} ofertas")

status, page = call("GET", "/offers?tracked_only=true&limit=100", token=token)
check("filtro tracked_only", status == 200, f"{len(page['items'])} ofertas de modelos seguidos")

status, page = call("GET", "/offers?q=golf&limit=100", token=token)
check("búsqueda por título", all("golf" in o["title"].lower() for o in page["items"]),
      f"{len(page['items'])} coincidencias")

print("\n== descarte manual ==")
status, dismissed = call("DELETE", f"/offers/{offer_id}", {"reason": "smoke test"}, token=token)
check("DELETE descarta (borrado lógico)", status == 200 and dismissed["status"] == "dismissed", f"HTTP {status}")

status, page = call("GET", "/offers?limit=200", token=token)
check("desaparece de la lista activa", all(o["id"] != offer_id for o in page["items"]))

status, page = call("GET", "/offers?status=dismissed&limit=200", token=token)
check("aparece en descartadas", any(o["id"] == offer_id for o in page["items"]))

# El scraper no debe resucitar una oferta descartada a mano.
status, _ = call("POST", "/offers/bulk", batch2, api_key=raw_key)
status, offer = call("GET", f"/offers/{offer_id}", token=token)
check("el scraper no resucita una descartada", offer["status"] == "dismissed", offer["status"])

status, restored = call("POST", f"/offers/{offer_id}/restore", token=token)
check("restaurar", status == 200 and restored["status"] == "active", f"HTTP {status}")

print("\n== favoritos ==")
status, before = call("GET", "/stats/overview", token=token)
favorites_before = before["favorite_offers"]

status, fav = call("POST", f"/offers/{offer_id}/favorite", token=token)
check("marcar favorito", status == 200 and fav["is_favorite"] is True, f"HTTP {status}")

status, again = call("POST", f"/offers/{offer_id}/favorite", token=token)
check("marcar dos veces es idempotente", status == 200 and again["is_favorite"] is True, f"HTTP {status}")

status, one = call("GET", f"/offers/{offer_id}", token=token)
check("is_favorite persiste al leer", one["is_favorite"] is True)

status, page = call("GET", "/offers?favorites_only=true&limit=200", token=token)
check(
    "filtro favorites_only",
    status == 200 and all(o["is_favorite"] for o in page["items"])
    and any(o["id"] == offer_id for o in page["items"]),
    f"{len(page['items'])} favoritas",
)

status, after = call("GET", "/stats/overview", token=token)
check("overview cuenta favoritos", after["favorite_offers"] == favorites_before + 1,
      f"{favorites_before} -> {after['favorite_offers']}")

# El favorito es de cada usuario: otro usuario no debe verlo marcado.
other_email = f"fav-{RUN_ID}@next-ride.dev"
call("POST", "/auth/register", {"email": other_email, "password": "smoketest123"})
status, other_tok = call("POST", "/auth/login", {"email": other_email, "password": "smoketest123"})
status, other_view = call("GET", f"/offers/{offer_id}", token=other_tok["access_token"])
check("el favorito es por usuario", other_view["is_favorite"] is False)

status, unfav = call("DELETE", f"/offers/{offer_id}/favorite", token=token)
check("desmarcar favorito", status == 200 and unfav["is_favorite"] is False, f"HTTP {status}")

status, page = call("GET", "/offers?favorites_only=true&limit=200", token=token)
check("desaparece de favoritos", all(o["id"] != offer_id for o in page["items"]))

print("\n== catálogo ==")
status, models = call("GET", "/car-models", token=token)
check("listar modelos con stats", status == 200 and len(models) > 0, f"{len(models)} modelos")
sample = models[0]
check("stats de modelo presentes", "median_price" in sample and "dealers_count" in sample,
      f"{sample['display_name']}: mediana={sample['median_price']}")

status, dealers = call("GET", "/dealers", token=token)
check("listar dealers con stats", status == 200 and len(dealers) > 0, f"{len(dealers)} dealers")
check("agregados de dealer", "active_offers" in dealers[0] and "avg_discount_pct" in dealers[0])
check("notes expuesto para poder editarlo", "notes" in dealers[0])

smoke_dealer = next(d for d in dealers if d["slug"] == "smoke-motors")
status, patched = call(
    "PATCH",
    f"/dealers/{smoke_dealer['id']}",
    {"rating": 4.4, "city": "Logroño", "notes": f"revisado en el run {RUN_ID}"},
    token=token,
)
check(
    "editar dealer (PATCH)",
    status == 200 and patched["rating"] == 4.4 and patched["city"] == "Logroño",
    f"HTTP {status}",
)
check("las notas se guardan", patched["notes"].endswith(RUN_ID), str(patched["notes"]))

status, dealers_q = call("GET", "/dealers?q=smoke", token=token)
check("filtro q en dealers", status == 200 and all("smoke" in d["name"].lower() for d in dealers_q),
      f"{len(dealers_q)} coincidencias")

print("\n== seguimiento de modelos ==")
target = next(m for m in models if not m["is_tracked"])
criteria = {
    "target_price": 20000,
    "max_mileage_km": 60000,
    "min_year": 2021,
    "notes": "solo automático",
}
status, tracked = call(
    "POST", "/tracked-models", {"car_model_id": target["id"], **criteria}, token=token
)
check("seguir modelo con criterios", status == 201 and tracked["car_model_id"] == target["id"],
      f"HTTP {status}")
check(
    "los criterios se guardan enteros",
    all(tracked[key] == value for key, value in criteria.items()),
    json.dumps({k: tracked[k] for k in criteria}),
)

status, again = call("POST", "/tracked-models", {"car_model_id": target["id"], "target_price": 19000}, token=token)
check("re-seguir actualiza (no 409)", status == 201 and again["target_price"] == 19000, f"HTTP {status}")

status, models2 = call("GET", "/car-models?tracked_only=true", token=token)
check("tracked_only filtra", status == 200 and any(m["id"] == target["id"] for m in models2),
      f"{len(models2)} seguidos")

tracked_row = next(m for m in models2 if m["id"] == target["id"])
check(
    "car-models expone los criterios",
    tracked_row["tracking"] is not None and tracked_row["tracking"]["target_price"] == 19000,
    json.dumps(tracked_row["tracking"]),
)

status, patched = call(
    "PATCH", f"/tracked-models/{again['id']}", {"max_mileage_km": 45000}, token=token
)
check(
    "editar criterios sin perder el resto",
    status == 200 and patched["max_mileage_km"] == 45000 and patched["target_price"] == 19000,
    f"HTTP {status}",
)

status, _ = call("DELETE", f"/tracked-models/{target['id']}", token=token)
check("dejar de seguir", status == 204, f"HTTP {status}")

# Seguir un modelo que no está en el catálogo: se crea en la misma llamada.
status, created = call(
    "POST",
    "/tracked-models",
    {"make": "Smoke", "model": "Identity", "trim": "1.0 TSI", "reference_price": 21000,
     "target_price": 17500},
    token=token,
)
check(
    "seguir por marca+modelo crea el modelo",
    status == 201 and created["car_model"]["display_name"] == "Smoke Identity 1.0 TSI",
    f"HTTP {status}: {json.dumps(created.get('car_model', {}))[:80]}",
)
check("el PVP de referencia se aplica", created["car_model"]["reference_price"] == 21000,
      str(created["car_model"]["reference_price"]))

status, _ = call("POST", "/tracked-models", {"trim": "sin marca"}, token=token)
check("sin identidad -> 422", status == 422, f"HTTP {status}")

status, _ = call("DELETE", f"/tracked-models/{created['car_model_id']}", token=token)
check("limpiar el seguimiento creado", status == 204, f"HTTP {status}")

print("\n== ranking IA ==")
status, body = call("POST", f"/car-models/{sample['id']}/rank", {"priorities": "bajo km"}, token=token)
check(
    "sin ANTHROPIC_API_KEY -> 503 claro",
    status == 503 and "ANTHROPIC_API_KEY" in json.dumps(body),
    f"HTTP {status}: {json.dumps(body)[:90]}",
)

status, body = call("GET", f"/car-models/{sample['id']}/ranking", token=token)
check("sin rankings -> 404 explicativo", status == 404, f"HTTP {status}")

status, runs = call("GET", f"/car-models/{sample['id']}/ranking-runs", token=token)
check("listar runs", status == 200 and isinstance(runs, list), f"{len(runs or [])} runs")

print("\n== stats ==")
status, overview = call("GET", "/stats/overview", token=token)
check("overview", status == 200 and overview["active_offers"] > 0,
      f"{overview['active_offers']} activas, {overview['dealers']} dealers, IA={overview['ai_enabled']}")

status, stats = call("GET", f"/stats/car-models/{sample['id']}", token=token)
check("stats por modelo", status == 200 and stats["count"] >= 0,
      f"n={stats['count']} mediana={stats['median_price']}")

print("\n== registro de usuario ==")
new_email = f"smoke-{RUN_ID}@next-ride.dev"
status, _ = call("POST", "/auth/register", {"email": new_email, "password": "smoketest123"})
check("registro", status == 201, f"HTTP {status}")
status, _ = call("POST", "/auth/register", {"email": new_email, "password": "smoketest123"})
check("email duplicado -> 409", status == 409, f"HTTP {status}")
status, _ = call("POST", "/auth/register", {"email": f"corta-{RUN_ID}@next-ride.dev", "password": "abc"})
check("password corta -> 422", status == 422, f"HTTP {status}")
status, tok2 = call("POST", "/auth/login", {"email": new_email, "password": "smoketest123"})
check("el usuario nuevo puede entrar", status == 200 and "access_token" in (tok2 or {}), f"HTTP {status}")

print(f"\n{'=' * 46}\n  {ok} PASS · {fail} FAIL\n{'=' * 46}")
raise SystemExit(1 if fail else 0)
