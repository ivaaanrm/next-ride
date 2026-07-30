---
name: daily-car-scan
description: Rutina diaria para recorrer pares de modelo y dealer, buscar ofertas públicas mediante fetch, Playwright o navegador, normalizarlas, deduplicarlas y enviar las nuevas o las que cambian de precio a la API. Usar para captar stock de Flexicar, coches.net, OcasionPlus, Iruri Motor y otros portales configurados, y terminar escribiendo un informe del run.
---

# Rutina diaria de captación de ofertas

Eres un agente de scraping que se ejecuta sin supervisión, una vez al día. Nadie va a
confirmar nada por ti: si algo es ambiguo, elige la opción conservadora, regístralo en el
informe y sigue. **El objetivo es reunir la mayor cantidad posible de ofertas válidas hasta
el límite configurado. No valores ni selecciones las “mejores” ofertas.**

## 0. Contexto de ejecución

- Directorio de trabajo: la raíz del proyecto. No escribas nunca fuera de él.
- Config: API `GET /api/v1/scraping/config`. La API es la única fuente de verdad.
- Copia de trabajo del run: `state/runtime-config.json`; se reemplaza al comenzar.
- Estado entre runs: `state/seen.json`.
- Salidas: `reports/YYYY-MM-DD.md` y `logs/`.
- API key: variable de entorno `NR_API_KEY`. **No la escribas en ningún fichero, log ni
  informe.** Si no está definida, aborta antes de scrapear nada.
- API base: variable `NR_API_BASE_URL`; por defecto `http://localhost:8000`.

## 1. Cargar configuración antes de navegar

Antes de abrir ningún dealer, ejecuta:

```bash
python3 scrapers/config.py --out state/runtime-config.json
```

Esto hace una petición autenticada:

```http
GET {NR_API_BASE_URL}/api/v1/scraping/config
X-API-Key: $NR_API_KEY
```

La respuesta tiene esta forma:

```json
{
  "max_per_target": 15,
  "targets": [{
    "id": 1,
    "label": "Audi A3",
    "make": "Audi",
    "model": "A3",
    "max_results": 15,
    "search_url": "https://...",
    "search_params": {"make_id": 4, "model_id": 345},
    "source": {
      "key": "coches.net",
      "name": "Coches.net",
      "base_url": "https://www.coches.net",
      "access": "playwright",
      "config": {}
    }
  }]
}
```

Si la petición falla, la key es rechazada o la respuesta no valida, **aborta sin navegar**.
No uses una copia de un run anterior como fallback. Si `targets` está vacío, termina con
éxito y deja constancia de que no había combinaciones activas.

Cada elemento de `targets[]` ya es un par `(modelo, fuente)`. Procésalos secuencialmente;
nunca navegues en paralelo sobre el mismo dominio. `source.access`, `search_url`,
`search_params`, `source.listing_url`, `source.notes` y `source.config` sustituyen por
completo a los antiguos JSON locales.

Si `search_url` es `null`, no inventes una URL:

- con `playwright` o `browser`, descúbrela desde la interfaz pública y guárdala mediante
  `PATCH /api/v1/scraping/targets/{target.id}`;
- con `fetch` o `manual`, marca el target como `configuration_missing` y continúa con el
  siguiente. Las fuentes con plantillas de slug deben llegar ya resueltas desde la API.

## 2. Elegir herramienta según el dealer

El campo `source.access` devuelto por la API manda. No lo cambies por tu cuenta.

| access | Qué usar | Cuándo |
|---|---|---|
| `fetch` | `WebFetch` o `curl` | El sitio renderiza en servidor y su robots.txt permite la ruta. Es el caso de Flexicar. Empieza siempre por aquí: es lo más rápido y barato. |
| `playwright` | Playwright MCP, con navegador como fallback | El listado se pinta por JS. Espera el selector del listado, no un `sleep` fijo. Si Playwright falla o es bloqueado en dos intentos, prueba el navegador real antes de marcar el target como `blocked`. |
| `browser` | Navegador real del usuario | Cuando hace falta una sesión normal del navegador o Playwright no puede leer el listado. Si el navegador no responde en dos intentos, marca el target como `skipped` y continúa. |
| `manual` | Nada | El sitio prohíbe el acceso automatizado. **No lo scrapees.** Márcalo como `blocked_by_policy` en el informe y pasa al siguiente. |

Reglas duras, sin excepciones:

- Antes del primer acceso a un dominio nuevo, lee su `/robots.txt` y anota en el informe
  cualquier restricción aplicable.
- Para `fetch` o `curl`, respeta siempre `robots.txt`. Si desautoriza la ruta, el target
  pasa a `blocked_by_policy`.
- Para `playwright` o `browser`, se permite navegar por páginas públicas aunque
  `robots.txt` desautorice su indexación automatizada. Esta excepción autoriza
  explícitamente coches.net y OcasionPlus cuando estén configurados con uno de esos
  métodos. No convierte en accesible contenido que exija login, consentimiento especial,
  un acuerdo comercial o eludir una medida técnica.
- Nunca resuelvas CAPTCHAs, ni rotes user-agents, IPs o proxies, ni intentes evadir
  detección de bots. Si te bloquean, el resultado del target es `blocked` y punto.
- Máximo 1 request o navegación cada 2 segundos por dominio y 3 páginas de listado por
  target.
- Solo lectura. No rellenes formularios, no inicies sesión, no pidas información al
  concesionario, no reserves nada.

## 2.1 Recetas de acceso por dealer

Usa estas recetas mientras la fuente conserve el mismo `source.access` en la API.
No redescubras una fuente o sus selectores en cada run.

| Dealer | Acceso | Fuente estable | Salida determinista |
|---|---|---|---|
| Flexicar | `fetch` | `__NEXT_DATA__` + endpoint `/vehicles` configurado por la API | `scrapers/flexicar.py` |
| coches.net | `playwright` | tarjetas del listado público | captura browser + `scrapers/cochesnet.py` |
| OcasionPlus | `playwright` | tarjetas con atributos `data-test` | captura browser + `scrapers/ocasionplus.py` |
| Iruri Motor | `fetch` | endpoint JSON público de Vehica | `scrapers/irurimotor.py` |

### Flexicar

1. Usa directamente el `search_url` resuelto del target.
2. Descarga el listado y extrae el JSON de `<script id="__NEXT_DATA__">`.
3. Lee las tarjetas desde `props.pageProps.initialVehicles[]` y el total desde
   `props.pageProps.countVehicles`.
4. Si la primera página no completa `max_results`, usa `source.config.vehicles_api_url`
   con `page=2`, `size=12`, `brands={search_params.make_slug}` y
   `models={search_params.model_slug}`; continúa hasta la página 3 como máximo.
   El HTML ignora `?page=2`, por lo que no debe usarse como paginación. Deduplica por ID
   y detente en cuanto completes el cupo.
5. Visita cada ficha seleccionada, respetando la pausa de 2 segundos, y lee
   `props.pageProps.vehicle` y `props.pageProps.dealership`. Si una ficha aislada falla,
   conserva los datos de la tarjeta y registra el aviso.
6. Usa `cashPrice` como precio de contado. No uses `price` (financiado), `quotaPrice`
   (cuota) ni `retailPrice` (PVP nuevo). Solo publica `previousPrice` como
   `original_price` cuando sea mayor que `cashPrice`.
7. Ejecuta el extractor y guarda el listado como fixture:

```bash
python3 scrapers/flexicar.py "Audi A3" --max 15 \
  --config state/runtime-config.json \
  --fixture scrapers/fixtures/flexicar-audi-a3-listing.html \
  --out state/raw-flexicar-audi-a3.json
```

### coches.net

1. Usa Playwright sobre `search_url`.
2. Si `search_url` es `null`, abre la web pública, entra en **Marca y modelo**, busca el
   nombre exacto, selecciónalo y pulsa **Aceptar**. No uses el buscador con IA para fijar
   el modelo: puede interpretar `A3` como `A4`.
3. Extrae la URL y los IDs resultantes y persístelos para futuros runs:

```http
PATCH {NR_API_BASE_URL}/api/v1/scraping/targets/{target.id}
X-API-Key: $NR_API_KEY
Content-Type: application/json

{"search_url":"https://...","search_params":{"make_id":4,"model_id":345}}
```

No continúes ese target hasta que el PATCH responda 2xx.
4. Espera a que exista `.mt-ListAds-item.mt-CardAd`. Desplázate y pagina, con al menos
   2 segundos entre cargas, hasta reunir `max_results` tarjetas válidas o agotar 3 páginas.
5. Haz una sola lectura masiva con `playwright.evaluate()` y captura por tarjeta:
   - título y URL: `.mt-CardAd-infoHeaderTitleLink`;
   - contado: `.mt-CardAdPrice-cashAmount`;
   - combustible, año, km, CV y ubicación: `.mt-CardAd-attrItem`;
   - etiquetas: `.mt-CardAd-tag`;
   - imagen: el `img` cuyo `alt` coincide con el título y cuya URL contiene `/vehicles/`.
6. Guarda las tarjetas en `state/cochesnet-browser-candidates.json`. Conserva los huecos
   publicitarios: el normalizador los elimina por falta de título/URL.
7. Ejecuta:

```bash
python3 scrapers/cochesnet.py \
  --snapshot state/cochesnet-browser-candidates.json \
  --fixture scrapers/fixtures/cochesnet-browser-candidates.json \
  --config state/runtime-config.json --out-dir state
```

El normalizador deduplica por URL y conserva las primeras `max_results` ofertas válidas en
el orden del portal. No puntúa, reordena ni escoge las más baratas.

### OcasionPlus

1. Usa Playwright con el `search_url` del target. Si es `null`, construye la búsqueda desde
   la interfaz pública y persiste la URL con el mismo `PATCH` descrito para Coches.net.
2. Identifica las tarjetas por enlaces `a[href*="/coches-segunda-mano/"]` y limita la
   lectura al modelo exacto mostrado en `[data-test="span-brand-model"]`.
3. Captura con una sola lectura masiva:
   - versión: `[data-test="span-version"]`;
   - precio de contado: `[data-test="span-price"]`; si no existe y solo hay un
     `[data-test="span-finance"]`, usa ese importe;
   - año, km, combustible y cambio: `[data-test="span-registration-date"]`,
     `[data-test="span-km"]`, `[data-test="span-fuel-type"]` y
     `[data-test="span-engine-transmission"]`;
   - delegación: `[data-test="div-dealer"]`.
4. Reúne ofertas en el orden del portal hasta alcanzar `max_results` válidas o agotar
   3 páginas. Guarda `state/ocasionplus-browser-candidates.json`.
5. Ejecuta:

```bash
python3 scrapers/ocasionplus.py \
  --snapshot state/ocasionplus-browser-candidates.json \
  --config state/runtime-config.json --out-dir state
```

Si faltan selectores estables o aparecen dos precios con semántica ambigua, no inventes el
dato: marca el target como `layout_changed` y conserva la captura para diagnosticarlo.

### Iruri Motor

1. Lee `robots.txt`; mientras no desautorice la ruta, usa `fetch`.
2. Consulta el `search_url` configurado por la API.
3. Lee `results[]` y sus `attributes[]`. Usa `Precio al contado`, `Año`, `Kilómetros`,
   `Potencia (CV)`, `Combustible`, `Cambio` y la primera imagen de `Galería`.
4. Acepta nombres que empiecen por el target. Para `Mitsubishi Montero`, esto incluye
   Sport, iO y LARGO. Conserva hasta `max_results` en el orden del inventario.
5. Ejecuta:

```bash
python3 scrapers/irurimotor.py "Mitsubishi Montero" --max 15 \
  --config state/runtime-config.json \
  --fixture scrapers/fixtures/irurimotor-mitsubishi.json \
  --out state/raw-irurimotor-mitsubishi-montero.json
```

### Secuencia común después de capturar

1. Guarda siempre la respuesta o captura fuente antes de normalizar.
2. Ejecuta el scraper/normalizador específico; no construyas el payload final a mano.
3. Valida todos los objetos contra `OfferIngest`.
4. Ejecuta primero `scrapers/ingest.py --dry-run` y comprueba el freno de emergencia,
   los descartes y las URLs distintas.
5. Solo entonces ejecuta el ingestor real con `NR_API_KEY` en el entorno.

## 3. Extraer

Para cada target, recorre el listado en su orden natural hasta reunir `max_results`
ofertas válidas o alcanzar el límite de 3 páginas. Elimina huecos y duplicados antes de
contar el cupo. **No calcules puntuaciones de selección, no ordenes por precio/km/año y no
abandones después de encontrar unas pocas ofertas atractivas.** De cada anuncio necesitas:

| Campo | Origen | Nota |
|---|---|---|
| `url` | enlace del anuncio | Absoluta, sin parámetros de tracking. Es la clave natural. |
| `title` | marca + modelo + versión + `(año)` | |
| `price` | precio de contado, entero en EUR | Si hay precio tachado y precio rebajado, el rebajado va aquí. |
| `original_price` | precio tachado | `null` si no hay. **No uses la cuota mensual**: suele corresponder a un precio financiado distinto. |
| `dealer_name` | dealer + delegación | p. ej. `Flexicar Cabrera de Mar`. |
| `make`, `model`, `trim` | del título | `make` y `model` canónicos según el target, `trim` tal cual lo publica el sitio. |
| `year`, `mileage_km` | ficha | Enteros. |
| `condition` | `used` \| `km0` \| `new` | |
| `fuel_type` | ver mapeo | |
| `transmission` | `manual` \| `automatic` | |
| `source` | clave de la fuente | |
| `external_id` | id numérico de la URL si existe | Si no, hash de la URL. |
| `scraped_at` | ISO 8601 UTC | |

Mapeo de combustible, porque cada portal lo llama distinto:

- `Diésel` → `diesel`
- `Gasolina` → `petrol`
- `Híbrido no enchufable`, `HEV`, `MHEV`, `mild hybrid` → `hybrid`
- `Híbrido enchufable`, `PHEV` → `plugin_hybrid`
- `Eléctrico` → `electric`
- `GLP` → `lpg`
- `GNC` → `other` mientras la API no tenga un valor específico

Un mild hybrid de 48V que en realidad es diésel se queda en `hybrid` para respetar la
clasificación de la fuente. Si algún día el esquema de la API gana un campo
`fuel_detail`, ahí irá el matiz.

Si un anuncio está marcado como reservado o vendido, inclúyelo con `"status": "reserved"`
solo si la API acepta ese campo; si no, exclúyelo y cuéntalo en el informe.

## 4. Validar antes de enviar

Descarta el anuncio individual si: falta `url`, `price` o `year`; el precio queda fuera de
`[500, 300000]`; el año fuera de `[1990, año_actual + 1]`; o los kilómetros fuera de
`[0, 900000]`.

Freno de emergencia por target: si más del 40% de los anuncios de un listado fallan la
validación, o si el listado devuelve 0 resultados cuando el run anterior devolvió más de
3, **no envíes nada de ese target**. Márcalo como `layout_changed` en el informe. Eso
casi siempre significa que el HTML cambió, no que el stock desapareció.

## 5. Deduplicar contra el estado

`state/seen.json` mapea `url` a `{ price, first_seen, last_seen, content_hash }`.

- URL nueva → `new`, se envía.
- URL conocida con precio distinto → `price_changed`, se envía (la plataforma decide si
  actualiza o historifica).
- URL conocida sin cambios → no se envía, solo se refresca `last_seen`.
- URL conocida que ya no aparece en el listado → `delisted`. No la envíes; anótala en el
  informe. Purga las entradas con más de 90 días sin verse.

Escribe `seen.json` de forma atómica (fichero temporal y `mv`) y **solo después** de que
la API haya respondido 2xx. Si el POST falla, el estado no se toca, para que el siguiente
run reintente.

## 6. Enviar a la API

```
POST {NR_API_BASE_URL}/api/v1/offers/bulk
X-API-Key: $NR_API_KEY
Content-Type: application/json
{"offers": [ ... ]}
```

- Lotes de 25 ofertas como máximo.
- 5xx o timeout: hasta 3 reintentos con backoff exponencial (2s, 4s, 8s).
- 4xx: **no reintentes**. Guarda el payload en `state/failed/{timestamp}.json` y el
  cuerpo de la respuesta en el informe. Un 401 aquí significa key mala o caducada: aborta
  el run entero, no sigas scrapeando para nada.
- Escribe siempre el payload enviado en `logs/payload-YYYY-MM-DD.json` antes del POST, así
  se puede reenviar a mano si algo se rompe.

## 7. Informe

Crea `reports/YYYY-MM-DD.md` con:

- Tabla por target: dealer, modelo, encontrados, nuevos, con bajada de precio, sin cambios,
  descartados, estado (`ok` / `blocked` / `blocked_by_policy` / `layout_changed` / `skipped`).
- Los cambios de precio del día, con importe y porcentaje.
- El déficit de cobertura por target (`max_results - válidas`) cuando no se complete el cupo.
- Errores y qué habría que arreglar a mano.

Termina imprimiendo por stdout un JSON de una línea:
`{"date":"...","targets":N,"sent":N,"new":N,"price_changed":N,"errors":N}`
para que el cron pueda alertar sin parsear el markdown.

## 8. Convergencia hacia scrapers deterministas

Esto es importante para el coste y la fiabilidad a medio plazo: **no seas tú el scraper si
puedes escribir el scraper.**

- Si en `scrapers/{dealer}.py` ya existe un extractor, ejecútalo en vez de leer el HTML tú.
- Si no existe, extrae tú los datos esta vez y, al terminar, escribe el extractor con los
  selectores o campos que has usado. Añade a `scrapers/fixtures/` una copia de la respuesta
  fuente del listado (HTML o JSON).
- Si un extractor existente falla, no lo parchees a ciegas: compara con el fixture, arregla
  el selector, actualiza el fixture y anota el cambio en el informe.

El objetivo es que en régimen estacionario el run diario sea casi todo código determinista
y tú solo intervengas cuando algo se rompe.
