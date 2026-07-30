# next-ride

Agrega ofertas de coches de distintos dealers, calcula métricas de valor y las
rankea con un agente de IA. Todo el stack se ejecuta con `docker compose`.

```
┌──────────────┐        ┌──────────────────────────┐        ┌──────────────┐
│  frontend    │  /api  │  backend (FastAPI)       │        │  Postgres 17 │
│  React+Vite  │───────▶│  · REST + JWT / API keys │───────▶│              │
│  nginx :8080 │        │  · métricas de valor     │        └──────────────┘
└──────────────┘        │  · agente de ranking ────┼──▶ Anthropic API
                        └──────────────────────────┘
                                    ▲
                                    │  POST /offers/bulk  (X-API-Key)
                        ┌───────────┴───────────┐
                        │  scraper (PENDIENTE)  │
                        └───────────────────────┘
```

El **scraper es un servicio aparte y no está implementado** en esta primera
versión: el backend expone el contrato de ingesta y la autenticación por API key
que necesitará.

---

## Arranque

```bash
cp .env.example .env
make up          # docker compose up -d --build
make seed        # datos de demostración (opcional pero recomendado)
```

| | URL |
|---|---|
| Frontend | http://localhost:8080 |
| API (Swagger) | http://localhost:8000/docs |
| Health | http://localhost:8000/health |

Usuario inicial: **admin@next-ride.dev** / **changeme123** (configurable en `.env`).

Para activar el ranking con IA, añade tu clave a `.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

y reinicia el backend:

```bash
make restart
```

Sin clave la aplicación funciona igual, pero el endpoint de ranking devuelve
`503` y la UI lo indica con un aviso.

Otros comandos: `make logs`, `make ps`, `make shell-db`, `make down`,
`make clean` (borra también el volumen de la BD).

---

## Modelo de datos

| Tabla | Para qué |
|---|---|
| `users`, `api_keys` | Personas (JWT) y credenciales de servicio (scraper) |
| `dealers` | Concesionarios, con valoración opcional |
| `car_models` | Marca + modelo + acabado, con PVP de referencia |
| `tracked_models` | Modelos que cada usuario decide seguir, con criterios |
| `offers` | Ofertas. Clave natural: `url` (el upsert va por ahí) |
| `offer_favorites` | Ofertas marcadas por cada usuario (marca personal, no estado de la oferta) |
| `offer_price_history` | Un registro por cambio de precio → detecta bajadas |
| `ranking_runs`, `offer_rankings` | Cada ejecución del agente y su veredicto por oferta |

Los enums se guardan como `VARCHAR` con `CHECK` (`native_enum=False`) para que
añadir un valor no requiera migrar un tipo de Postgres.

### Esquema y migraciones

En la v1 el esquema se crea al arrancar (`AUTO_CREATE_TABLES=true`), lo que
garantiza que coincide con los modelos. Alembic ya está configurado; cuando el
esquema empiece a evolucionar:

```bash
docker compose exec backend alembic revision --autogenerate -m "init"
```

```bash
docker compose exec backend alembic upgrade head
```

y pon `AUTO_CREATE_TABLES=false`.

---

## Métricas

Se calculan **al leer**, no se persisten: así siguen siendo correctas cuando
entran ofertas nuevas y la mediana del modelo se mueve.

| Métrica | Cálculo |
|---|---|
| `discount_pct` | Descuento sobre el PVP anunciado por el dealer |
| `price_vs_median_pct` | Desviación respecto a la mediana del modelo (la señal fuerte) |
| `price_vs_reference_pct` | Desviación respecto al PVP de referencia del modelo |
| `price_drop_pct` | Bajada desde el primer precio que vimos |
| `km_per_year` | Kilometraje anualizado |
| `days_listed` | Días desde que se vio por primera vez |
| `value_score` | Heurística 0-100 que combina las anteriores |

`value_score` es la señal **determinista** de la plataforma. La puntuación del
agente de IA es independiente y se muestra aparte: si discrepan, es información.

---

## Agente de IA

`backend/app/services/ranking_agent.py`. Loop agéntico sobre la Messages API de
Anthropic (`claude-opus-5`) con cuatro tools:

| Tool | Qué hace |
|---|---|
| `get_market_stats` | Mediana, mín/máx, km y año medios, nº de dealers |
| `list_offers` | Ofertas candidatas con todas sus métricas ya calculadas |
| `get_offer_price_history` | Historial de precios de una oferta |
| `submit_ranking` | **Terminal.** Entrega el ranking con salida estructurada (`strict: true`) |

Decisiones que merecen explicación:

- **Loop manual en lugar del tool runner del SDK** (que está en beta): hace falta
  acotar iteraciones, tener una tool terminal y persistir la traza y el consumo
  de tokens en `ranking_runs`.
- **El modelo ordena, no decide qué existe.** `submit_ranking` se valida contra
  las ofertas candidatas reales: los `offer_id` inventados o duplicados se
  descartan, los rangos se renumeran 1..N y las puntuaciones se acotan a 0-100.
- **Ningún fallo se propaga.** Rechazo del modelo, truncado por `max_tokens`,
  límite de iteraciones o caída de red quedan como `status=failed` con el motivo
  en `RankingRun.error`.
- **Parámetros según la API actual**: sin `temperature`/`top_p` y sin
  `budget_tokens` (devuelven 400 en Opus 5); el esfuerzo se controla con
  `output_config.effort`. Se reenvía `response.content` íntegro para preservar
  los bloques de *thinking*.
- **Fallbacks de servidor** activados por defecto (`ANTHROPIC_ENABLE_FALLBACKS`);
  si la cuenta no tiene el beta habilitado, se degrada solo y sigue.

El run es asíncrono: `POST /car-models/{id}/rank` responde `202` y el frontend
hace polling sobre `GET /ranking-runs/{id}`.

---

## API

Prefijo `/api/v1`. Documentación navegable en `/docs`.

### Autenticación
| Método | Ruta | |
|---|---|---|
| `POST` | `/auth/register` | Registro (se puede cerrar con `ALLOW_REGISTRATION=false`) |
| `POST` | `/auth/login` | JSON → access + refresh token |
| `POST` | `/auth/token` | Variante OAuth2 form, para el botón *Authorize* de `/docs` |
| `POST` | `/auth/refresh` | Renueva el par de tokens |
| `GET`/`PATCH` | `/auth/me` | Usuario actual |

### Ingesta (la usará el scraper)
| Método | Ruta | |
|---|---|---|
| `POST` | `/offers` | Una oferta. Upsert por `url` |
| `POST` | `/offers/bulk` | Hasta 500 ofertas; **cada una se valida por separado** |
| `GET`/`POST`/`DELETE` | `/api-keys` | Gestión de credenciales de servicio |

Acepta `Authorization: Bearer <jwt>` **o** `X-API-Key: nr_<prefijo>_<secreto>`.
De la API key solo se guarda el hash SHA-256; el valor en claro se muestra una
única vez, al crearla.

```bash
curl -X POST http://localhost:8000/api/v1/offers/bulk -H "X-API-Key: nr_xxxx_yyyy" -H "Content-Type: application/json" -d '{"offers":[{"url":"https://dealer.example/coche/123","title":"Toyota Corolla 1.8 Hybrid Active (2022)","price":24500,"original_price":27900,"dealer_name":"Autos Ribera","make":"Toyota","model":"Corolla","trim":"1.8 Hybrid Active","year":2022,"mileage_km":38000,"condition":"used","fuel_type":"hybrid","transmission":"automatic"}]}'
```

Dealers y modelos se crean solos si no existen (`get_or_create` por slug). Una
oferta mal formada se reporta en `errors` sin tumbar el lote.

### Ofertas
| Método | Ruta | |
|---|---|---|
| `GET` | `/offers` | Paginado. Filtros: `q`, `car_model_id`, `dealer_id`, `condition`, `fuel_type`, `min_price`, `max_price`, `max_mileage_km`, `min_year`, `tracked_only`, `favorites_only`, `status`. `sort`: `value_score`, `ai_score`, `price`, `-price`, `mileage_km`, `-year`, `-first_seen_at` |
| `GET` | `/offers/{id}` · `/offers/{id}/price-history` | Detalle e historial |
| `DELETE` | `/offers/{id}` | **Descarte manual** (borrado lógico) |
| `POST` | `/offers/{id}/restore` | Deshace el descarte |
| `POST`/`DELETE` | `/offers/{id}/favorite` | Marca / desmarca favorito. Idempotentes; devuelven la oferta |

El descarte es lógico a propósito: el scraper vuelve a ver la oferta en el
origen y **no debe resucitarla**. Una oferta `expired` sí se reactiva si reaparece.

Los favoritos son **por usuario**: `OfferRead.is_favorite` es la marca de quien
hace la petición, no un atributo de la oferta. Por eso viven en su propia tabla
y no como columna de `offers`, que es compartida y la escribe el scraper.

### Catálogo, seguimiento y ranking
| Método | Ruta | |
|---|---|---|
| `GET`/`POST`/`PATCH` | `/car-models` | Modelos con stats de precio, `is_tracked` y el bloque `tracking` (los criterios del usuario) |
| `GET`/`POST`/`PATCH`/`DELETE` | `/tracked-models` | Modelos a seguir, con precio objetivo, km máx., año mín. y notas |
| `GET`/`POST`/`PATCH` | `/dealers` | Dealers con agregados. Filtros: `q`, `include_inactive` |
| `POST` | `/car-models/{id}/rank` | Lanza el agente → `202` |
| `GET` | `/car-models/{id}/ranking` | Último ranking completado |
| `GET` | `/ranking-runs/{id}` | Estado de un run (polling) |
| `GET` | `/stats/overview` · `/stats/car-models/{id}` | Métricas de cabecera |

`POST /tracked-models` acepta el modelo de dos formas: `car_model_id` si ya está
en el catálogo, o `make` + `model` (+ `trim`) para **crearlo en la misma
llamada**. Seguir un modelo que todavía no existe no debería ser un flujo de dos
pasos con un 409 en medio. Re-seguir un modelo ya seguido actualiza sus criterios
en lugar de fallar.

---

## Frontend

React + Vite + TypeScript, CSS propio con tokens (sin framework de UI).
Estética minimalista inspirada en Twenty CRM: sidebar plegable, tabla densa de
registros con cabecera *sticky*, chips de color suave, un único azul de acento
y radios de 4 px.

La sidebar se pliega a un riel de iconos de 52 px con el botón `«` o con
**⌘/Ctrl+B**, y la preferencia se guarda en `localStorage`: la tabla de ofertas
tiene doce columnas y esos 172 px de más se notan. Plegada, los `title` y los
`aria-label` son la única etiqueta de cada icono. Por debajo de 860 px la sidebar
sigue oculta, como antes.

| Vista | |
|---|---|
| **Ofertas** | Tabla principal con métricas, filtros, orden, favoritos (★) y descarte manual |
| **Modelos** | Panel único de seguimiento (elegir del catálogo o crear al vuelo + criterios) y panel de ranking IA con pros/cons y traza de tools |
| **Dealers** | Agregados por concesionario, con edición y aviso de duplicados |
| **Ajustes** | API keys y contrato de ingesta |

Dos decisiones de interacción que no son obvias:

- **Marcar un favorito no recarga la tabla.** Se parchea la fila con la oferta que
  devuelve el endpoint, para no perder la posición ni el orden mientras se marcan
  varias seguidas.
- **Seguir un modelo es un solo paso.** Antes había que crear el modelo, buscarlo
  en la tabla y pulsar «Seguir», y los criterios (`target_price`, km, año, notas)
  no había forma de tocarlos desde la UI. Ahora el panel «Seguir un modelo» /
  «Criterios» hace las dos cosas a la vez. La columna **Objetivo** marca en verde
  el modelo cuya oferta más baja ya está por debajo del precio objetivo.

Desarrollo con recarga en caliente (proxy a `localhost:8000`):

```bash
cd frontend && npm install && npm run dev
```

---

## Verificación

Dos suites, ambas ejecutables sin credenciales de Anthropic:

```bash
python3 backend/scripts/smoke_api.py
```

```bash
docker compose exec backend python -m scripts.test_ranking_agent
```

- `smoke_api.py` (68 comprobaciones) recorre la API end-to-end contra el stack en
  marcha: autenticación, ingesta con API key, métricas, filtros, orden, descarte,
  favoritos (incluido que son por usuario), seguimiento con criterios y edición de
  dealers. Es idempotente.
- `test_ranking_agent.py` (39 comprobaciones) ejercita el agente con la API de
  Anthropic simulada: despacho de tools, salida estructurada, renumerado de
  rangos, descarte de `offer_id` inventados, y las rutas de error (rechazo,
  `max_tokens`, límite de iteraciones, caída de red). Lo único que no cubre es el
  transporte HTTP real.

---

## Pendiente

- **Servicio scraper** (fuera del alcance de esta versión). Consume
  `POST /offers/bulk` con `X-API-Key`.
- Ordenar por puntuación evalúa hasta 500 ofertas coincidentes; por encima de
  eso conviene materializar `value_score` o paginar por cursor.
- Los runs de ranking se ejecutan en `BackgroundTasks`. Con varias réplicas del
  backend conviene mover esto a una cola (el candado por modelo ya existe: no se
  admiten dos runs simultáneos del mismo modelo).
- Rotación de refresh tokens y revocación por `jti`.
- Alertas cuando una oferta baja del `target_price` de un modelo seguido. Los
  criterios ya se editan desde la UI y la columna **Objetivo** marca cuándo se
  cumple, pero es una comprobación al leer: falta el disparador que avise sin que
  nadie mire la pantalla.
- Los criterios `max_mileage_km` y `min_year` de `tracked_models` se guardan y se
  editan, pero todavía no filtran nada por sí solos: el filtrado en `/offers` se
  pide a mano. Son la entrada natural del mismo disparador de alertas.
