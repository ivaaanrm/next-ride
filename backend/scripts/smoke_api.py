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
import urllib.parse
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
            "raw": {"color": "Blanco perla", "plazas": 5, "garantia": "2 años oficial"},
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

status, detail = call("GET", f"/offers/{offer_id}/raw", token=token)
check(
    "payload crudo del scraper accesible aparte",
    status == 200 and detail["raw"]["color"] == "Blanco perla",
    f"HTTP {status}: {json.dumps(detail)[:70]}",
)

status, offer = call("GET", f"/offers/{offer_id}", token=token)
check("raw NO viaja en el listado/detalle", "raw" not in offer)
m = offer["metrics"]
check("price_drop_pct calculado", m["price_drop_pct"] is not None, f"{m['price_drop_pct']}%")
check("discount_pct calculado", m["discount_pct"] is not None, f"{m['discount_pct']}%")
check("vs mediana calculado", m["price_vs_median_pct"] is not None, f"{m['price_vs_median_pct']}%")
check("value_score en rango", 0 <= (m["value_score"] or -1) <= 100, str(m["value_score"]))

print("\n== puntuación de valor: desglose y configuración ==")
breakdown = m["score_breakdown"]
check("desglose con los 8 componentes", len(breakdown) == 8, f"{len(breakdown)} componentes")

available = [b for b in breakdown if b["available"]]
points = sum(b["points"] for b in available)
check("sum(points) del desglose == value_score", abs(points - m["value_score"]) <= 0.1,
      f"{round(points, 2)} vs {m['value_score']}")
check("los pesos finales suman 100%",
      abs(sum(b["weight_pct"] for b in breakdown) - 100) <= 0.5,
      str(round(sum(b["weight_pct"] for b in breakdown), 1)))
check("un componente sin dato pesa 0",
      all(b["weight_pct"] == 0 and b["points"] is None for b in breakdown if not b["available"]))

# Casi ningún modelo scrapeado tiene PVP curado: el valor esperado debe salir
# igualmente, anclado al PVP estimado del mercado (curva de depreciación invertida).
status, page_big = call("GET", "/offers?limit=200", token=token)
via_mercado = [
    o for o in page_big["items"]
    if o["metrics"]["expected_price_eur"] and o["metrics"]["expected_price_source"] == "mercado"
]
check("el valor esperado se estima sin PVP curado (ancla de mercado)",
      len(via_mercado) > 0, f"{len(via_mercado)} ofertas con valor esperado vía mercado")

status, config = call("GET", "/scoring/config", token=token)
check("GET /scoring/config", status == 200 and len(config["components"]) == 8, f"HTTP {status}")
check("cada componente se explica solo",
      all(c["description"] and c["label"] for c in config["components"]))
original_weights = config["weights"]

# Editar pesos cambia la puntuación de forma predecible: todo el peso a la
# frescura y una oferta recién ingestada (0 días) debe puntuar 100.
solo_freshness = dict.fromkeys(original_weights, 0) | {"freshness": 100}
status, updated = call("PUT", "/scoring/config", {"weights": solo_freshness}, token=token)
check("PUT /scoring/config aplica pesos", status == 200
      and updated["weights"]["freshness"] == 100, f"HTTP {status}")

status, offer_fresh = call("GET", f"/offers/{offer_id}", token=token)
check("con todo el peso en frescura, la oferta recién vista puntúa 100",
      offer_fresh["metrics"]["value_score"] == 100,
      str(offer_fresh["metrics"]["value_score"]))

todos_cero = {"weights": dict.fromkeys(original_weights, 0)}
status, _ = call("PUT", "/scoring/config", todos_cero, token=token)
check("todos los pesos a cero -> 422", status == 422, f"HTTP {status}")
negativo = {"weights": dict(original_weights, mileage=-5)}
status, _ = call("PUT", "/scoring/config", negativo, token=token)
check("peso negativo -> 422", status == 422, f"HTTP {status}")

status, restored_cfg = call("PUT", "/scoring/config", {"weights": original_weights}, token=token)
check("restaurar pesos originales", status == 200
      and restored_cfg["weights"] == original_weights, f"HTTP {status}")

print("\n== ofertas: filtros y ordenación ==")
status, page = call("GET", "/offers?limit=5&sort=price", token=token)
prices = [o["price"] for o in page["items"]]
check("sort=price ascendente", status == 200 and prices == sorted(prices), str([int(p) for p in prices]))

status, page = call("GET", "/offers?limit=5&sort=-price", token=token)
prices = [o["price"] for o in page["items"]]
check("sort=-price descendente", prices == sorted(prices, reverse=True), str([int(p) for p in prices]))

# Los sentidos que alimentan las cabeceras de la tabla. `year` y `mileage_km`
# son nullables: los None se van al final en los dos sentidos, así que la
# comprobación mira solo el tramo con dato.
status, page = call("GET", "/offers?limit=100&sort=year", token=token)
years = [o["year"] for o in page["items"] if o["year"] is not None]
check("sort=year ascendente", status == 200 and years == sorted(years), str(years[:8]))

status, page = call("GET", "/offers?limit=100&sort=-mileage_km", token=token)
km = [o["mileage_km"] for o in page["items"] if o["mileage_km"] is not None]
check("sort=-mileage_km descendente", status == 200 and km == sorted(km, reverse=True), str(km[:8]))

status, page = call("GET", "/offers?limit=100&sort=first_seen_at", token=token)
seen = [o["first_seen_at"] for o in page["items"]]
check("sort=first_seen_at ascendente", status == 200 and seen == sorted(seen), f"{len(seen)} ofertas")

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

print("\n== métricas del conjunto filtrado ==")
# Lo que hay que garantizar es que /offers/stats y /offers describan el MISMO
# conjunto: una media calculada sobre otras filas es peor que no enseñar media.
status, stats_all = call("GET", "/offers/stats", token=token)
check("GET /offers/stats no lo captura /offers/{id}", status == 200, f"HTTP {status}")

status, page = call("GET", "/offers?limit=200", token=token)
check("el recuento coincide con el del listado sin filtro",
      stats_all["count"] == page["total"], f"{stats_all['count']} vs {page['total']}")

QS = "max_price=25000&condition=used"
status, stats_f = call("GET", f"/offers/stats?{QS}", token=token)
status2, page_f = call("GET", f"/offers?{QS}&limit=200", token=token)
items = page_f["items"]
check("el recuento coincide con el del listado filtrado",
      status == 200 and status2 == 200 and stats_f["count"] == page_f["total"],
      f"{stats_f['count']} vs {page_f['total']}")
check("filtrar cambia las métricas (no son globales)",
      stats_f["count"] < stats_all["count"]
      and stats_f["avg_price"] != stats_all["avg_price"],
      f"{stats_f['avg_price']} filtrado vs {stats_all['avg_price']} global")

if items and len(items) == page_f["total"]:
    expected = sum(o["price"] for o in items) / len(items)
    check("avg_price coincide con la media de las filas devueltas",
          abs(stats_f["avg_price"] - expected) < 0.5,
          f"{stats_f['avg_price']} vs {round(expected, 2)}")

    kms = [o["mileage_km"] for o in items if o["mileage_km"] is not None]
    expected_km = sum(kms) / len(kms) if kms else None
    check("avg_mileage_km ignora los nulos",
          expected_km is None or abs(stats_f["avg_mileage_km"] - expected_km) < 1,
          f"{stats_f['avg_mileage_km']} vs {round(expected_km) if expected_km else None}")

    kpy = [o["metrics"]["km_per_year"] for o in items if o["metrics"]["km_per_year"] is not None]
    expected_kpy = sum(kpy) / len(kpy) if kpy else None
    check("avg_km_per_year usa el mismo cálculo que las métricas por oferta",
          expected_kpy is None or abs(stats_f["avg_km_per_year"] - expected_kpy) < 1,
          f"{stats_f['avg_km_per_year']} vs {round(expected_kpy) if expected_kpy else None}")

    models = {o["car_model"]["id"] for o in items}
    check("car_models cuenta modelos distintos del filtro",
          stats_f["car_models"] == len(models), f"{stats_f['car_models']} vs {len(models)}")

status, empty = call("GET", "/offers/stats?max_price=1", token=token)
check("filtro sin resultados -> ceros y medias nulas",
      status == 200 and empty["count"] == 0 and empty["avg_price"] is None
      and empty["best_deal"] is None,
      f"count={empty['count']} avg={empty['avg_price']}")

# El dominio del deslizador de precio. La propiedad que importa es que NO se
# mueva con el propio filtro de precio: si se moviera, cada arrastre encogería
# el carril a la selección y no habría forma de volver a abrirlo. Se compara
# contra el mismo filtro sin el precio, no contra el global: `condition=used` sí
# debe mover el dominio, y compararlo con el global no distinguiría las dos cosas.
status, stats_c = call("GET", "/offers/stats?condition=used", token=token)
check("price_floor/ceiling ignoran el filtro de precio",
      status == 200
      and stats_f["price_floor"] == stats_c["price_floor"]
      and stats_f["price_ceiling"] == stats_c["price_ceiling"],
      f"[{stats_f['price_floor']}, {stats_f['price_ceiling']}] con max_price=25000 vs "
      f"[{stats_c['price_floor']}, {stats_c['price_ceiling']}] sin él")

check("el dominio sobrevive a un filtro de precio sin resultados",
      empty["price_floor"] is not None and empty["price_ceiling"] is not None,
      f"count=0 pero [{empty['price_floor']}, {empty['price_ceiling']}]")

# El dominio de años, igual: inmune a `min_year`/`max_year` pero sensible al
# resto. Que el de precio SÍ se mueva con `max_price` es lo que demuestra que
# cada rango se exime del suyo y no de todos.
status, stats_y = call("GET", "/offers/stats?min_year=2020", token=token)
check("year_floor/ceiling ignoran el filtro de año",
      status == 200
      and stats_y["year_floor"] == stats_all["year_floor"]
      and stats_y["year_ceiling"] == stats_all["year_ceiling"],
      f"[{stats_y['year_floor']}, {stats_y['year_ceiling']}] con min_year=2020 vs "
      f"[{stats_all['year_floor']}, {stats_all['year_ceiling']}] sin él")

status, page_y = call("GET", "/offers?min_year=2020&max_year=2021&limit=200", token=token)
years = [o["year"] for o in page_y["items"]]
check("filtro max_year acota por arriba",
      status == 200 and all(y is not None and 2020 <= y <= 2021 for y in years),
      f"{len(years)} ofertas, años {sorted(set(years))}")

status, page = call("GET", "/offers?limit=200", token=token)
prices = [o["price"] for o in page["items"]]
if prices and len(prices) == page["total"]:
    check("price_floor/ceiling son los extremos reales del conjunto",
          abs(stats_all["price_floor"] - min(prices)) < 0.01
          and abs(stats_all["price_ceiling"] - max(prices)) < 0.01,
          f"[{stats_all['price_floor']}, {stats_all['price_ceiling']}] vs "
          f"[{min(prices)}, {max(prices)}]")

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

print("\n== corrección manual ==")
status, before_edit = call("GET", f"/offers/{offer_id}", token=token)
km_per_year_before = before_edit["metrics"]["km_per_year"]

status, edited = call(
    "PATCH", f"/offers/{offer_id}", {"year": 2018, "mileage_km": 61000}, token=token
)
check(
    "PATCH corrige año y km",
    status == 200 and edited["year"] == 2018 and edited["mileage_km"] == 61000,
    f"HTTP {status}",
)
check(
    "los campos tocados quedan anclados",
    set(edited["manual_fields"]) == {"year", "mileage_km"},
    str(edited["manual_fields"]),
)
check("la edición va firmada", edited["edited_at"] is not None)
# El cuerpo lleva el diff, no el formulario: lo que no viaja no se toca.
check("lo no enviado se queda como estaba", edited["title"] == batch["offers"][0]["title"])
check(
    "las métricas se rehacen al leer",
    edited["metrics"]["km_per_year"] != km_per_year_before,
    f"{km_per_year_before} -> {edited['metrics']['km_per_year']}",
)

# El scraper vuelve a pasar con sus datos de siempre: lo anclado sobrevive, el
# resto de la oferta se sigue actualizando. Es la mitad que hace útil corregir.
batch3 = {
    "offers": [
        dict(
            batch["offers"][0],
            price=21490,
            title="Toyota Corolla 1.8 Hybrid Active (2023) reacondicionado",
        )
    ]
}
status, _ = call("POST", "/offers/bulk", batch3, api_key=raw_key)
status, rescraped = call("GET", f"/offers/{offer_id}", token=token)
check(
    "el scraper no pisa lo corregido a mano",
    rescraped["year"] == 2018 and rescraped["mileage_km"] == 61000,
    f"año {rescraped['year']} · {rescraped['mileage_km']} km",
)
check(
    "y sí actualiza lo que no está anclado",
    rescraped["title"].endswith("reacondicionado"),
    rescraped["title"][-24:],
)

status, history_before = call("GET", f"/offers/{offer_id}/price-history", token=token)
status, repriced = call("PATCH", f"/offers/{offer_id}", {"price": 20990}, token=token)
check("PATCH corrige el precio", status == 200 and repriced["price"] == 20990, f"HTTP {status}")
status, history_after = call("GET", f"/offers/{offer_id}/price-history", token=token)
check(
    "corregir el precio se anota en el historial",
    len(history_after) == len(history_before) + 1 and history_after[-1]["price"] == 20990,
    f"{len(history_before)} -> {len(history_after)} puntos",
)

status, _ = call("PATCH", f"/offers/{offer_id}", {"title": None}, token=token)
check("vaciar un campo obligatorio -> 422", status == 422, f"HTTP {status}")

status, _ = call("PATCH", f"/offers/{offer_id}", {"price": 0}, token=token)
check("precio no positivo -> 422", status == 422, f"HTTP {status}")

status, _ = call("PATCH", f"/offers/{offer_id}", {"car_model_id": 10_000_000}, token=token)
check("reatribuir a un modelo inexistente -> 404", status == 404, f"HTTP {status}")

status, released = call("PATCH", f"/offers/{offer_id}", {"clear_manual": True}, token=token)
check(
    "soltar los anclajes",
    status == 200 and released["manual_fields"] == [],
    f"HTTP {status}: {released.get('manual_fields')}",
)
check("soltar no borra lo corregido", released["year"] == 2018, str(released["year"]))
status, _ = call("POST", "/offers/bulk", batch3, api_key=raw_key)
status, back = call("GET", f"/offers/{offer_id}", token=token)
check(
    "suelto, el scraper vuelve a mandar",
    back["year"] == 2023 and back["mileage_km"] == 11000,
    f"año {back['year']} · {back['mileage_km']} km",
)

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
# El ranking va por binomio marca-modelo (clave en query, no en la ruta).
binomio = urllib.parse.quote(f"{sample['make'].lower()}|{sample['model'].lower()}")
status, overview = call("GET", "/stats/overview", token=token)
if overview["ai_enabled"]:
    # Con API key configurada no se lanza un run real (cuesta dinero): se
    # comprueba el contrato de errores, que no depende del agente.
    status, body = call("POST", "/car-model-groups/rank?key=zzz%7Czzz", {}, token=token)
    check("binomio desconocido -> 404 claro", status == 404 and "zzz" in json.dumps(body),
          f"HTTP {status}: {json.dumps(body)[:70]}")
else:
    status, body = call(
        "POST", f"/car-model-groups/rank?key={binomio}", {"priorities": "bajo km"}, token=token
    )
    check(
        "sin ANTHROPIC_API_KEY -> 503 claro",
        status == 503 and "ANTHROPIC_API_KEY" in json.dumps(body),
        f"HTTP {status}: {json.dumps(body)[:90]}",
    )

status, body = call("GET", "/car-model-groups/ranking?key=zzz%7Czzz", token=token)
check("sin rankings -> 404 explicativo", status == 404, f"HTTP {status}")

status, runs = call("GET", f"/car-model-groups/ranking-runs?key={binomio}", token=token)
check("listar runs del binomio", status == 200 and isinstance(runs, list), f"{len(runs or [])}")

status, _ = call("GET", "/ranking-runs/99999999", token=token)
check("run inexistente -> 404", status == 404, f"HTTP {status}")

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
