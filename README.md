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
| `offers` | Ofertas. Clave natural: `url` (el upsert va por ahí). `manual_fields` lista las columnas corregidas a mano, que el scraper ya no pisa |
| `offer_favorites` | Ofertas marcadas por cada usuario (marca personal, no estado de la oferta) |
| `offer_price_history` | Un registro por cambio de precio → detecta bajadas |
| `ranking_runs`, `offer_rankings` | Cada ejecución del agente y su veredicto por oferta |

Los enums se guardan como `VARCHAR` con `CHECK` (`native_enum=False`) para que
añadir un valor no requiera migrar un tipo de Postgres.

### Esquema y migraciones

El esquema lo llevan **dos** mecanismos, y los dos hacen falta:

- `Base.metadata.create_all` al arrancar la app (`AUTO_CREATE_TABLES=true`) crea
  las **tablas** que falten. No toca una tabla que ya exista.
- **Alembic** lleva los **ALTER**: columnas nuevas sobre tablas vivas, que es
  justo lo que `create_all` no sabe hacer.

Las migraciones no construyen la base desde cero —dan por hecho que `create_all`
ya creó las tablas—, así que `AUTO_CREATE_TABLES` no puede ponerse a `false`
mientras no exista una revisión inicial completa.

`alembic upgrade head` lo lanza el `entrypoint.sh` de la imagen del backend
antes de arrancar uvicorn, así que **no hay que ejecutarlo a mano**: migra igual
el despliegue continuo que un `docker compose up` en el servidor. Si una
migración falla, el contenedor no arranca y el despliegue revierte.

Para lanzarlo suelto (una base que se quedó atrás, un `uvicorn` local):

```bash
docker compose exec backend alembic upgrade head
```

Todas las revisiones se saltan a sí mismas si el esquema ya tiene la forma
nueva, así que aplicarlas sobre una base recién creada por `create_all` no falla:

| Revisión | Qué cambia |
|---|---|
| `0001_ranking_por_binomio` | Mueve el objetivo de `ranking_runs` de `car_model_id` al binomio marca-modelo |
| `0002_scraping_config_api` | `scrape_sources` y `scrape_targets` |
| `0003_score_config` | `score_config`: pesos y parámetros editables de la puntuación |
| `0004_offer_manual_edit` | `offers.manual_fields`, `edited_at` y `edited_by_id`: la corrección manual |
| `0005_offer_manual_ratings` | `offers.equipment_rating` y `apparent_condition_rating`: las notas manuales |
| `0006_power_score_curve` | La ventana de potencia de la puntuación pasa a 100-200 CV con curva cuadrática |

De la `0004` en adelante todas tocan tablas vivas y con datos, así que son
**obligatorias**: sin ellas la app arranca y revienta en la primera consulta que
seleccione la columna que falta.

Por eso `/health` compara la revisión aplicada con la última escrita y devuelve
**503** si no coinciden: un esquema desfasado deja el contenedor en `unhealthy`
en vez de dar verde sobre una app rota. La respuesta lleva el detalle:

```json
{"status": "stale_schema", "schema": {"current": "0004_offer_manual_edit", "head": "0006_power_score_curve", "up_to_date": false}}
```

Para regenerar el esquema desde cero (borra los datos):

```bash
make clean && make up
```

---

## Métricas

Se calculan **al leer**, no se persisten: así siguen siendo correctas cuando
entran ofertas nuevas y la mediana del modelo se mueve.

| Métrica | Cálculo |
|---|---|
| `discount_pct` | Descuento sobre el PVP anunciado por el dealer |
| `price_vs_median_pct` | Desviación respecto a la mediana del modelo (la señal fuerte) |
| `price_vs_reference_pct` | Desviación respecto al PVP de referencia del modelo |
| `expected_price_eur` | Valor teórico hoy: precio de nuevo depreciado por edad (curva media) y ajustado por km |
| `price_vs_expected_pct` | Desviación respecto a ese valor esperado |
| `expected_price_source` | El ancla usada: `pvp` (curado en la versión) o `mercado` (estimado) |
| `price_drop_pct` | Bajada desde el primer precio que vimos |
| `km_per_year` | Kilometraje anualizado |
| `days_listed` | Días desde que se vio por primera vez |
| `value_score` | Puntuación 0-100: media ponderada de las señales (ver abajo) |
| `score_breakdown` | El desglose auditable de esa media, señal a señal |

### Puntuación de valor (`value_score`)

`backend/app/services/scoring.py`. Es la señal **determinista** de la
plataforma: los mismos datos y la misma fecha dan siempre la misma cifra. La
puntuación del agente de IA es independiente y se muestra aparte: si
discrepan, es información.

Cada señal se normaliza a un subscore 0-100 (50 = neutro, lineal con topes) y
la puntuación es su **media ponderada**. Si a una oferta le falta una señal
(sin PVP de referencia, sin valoración del dealer…), su peso se reparte entre
las presentes: dos ofertas con datos distintos siguen siendo comparables y la
escala 0-100 se usa entera.

| Señal | Peso por defecto | Subscore |
|---|---|---|
| Precio vs mercado | 30 | Desviación frente a la mediana del binomio (mín. 3 comparables); ±25 % cubre la escala |
| Precio vs valor esperado | 25 | Desviación frente al PVP depreciado por edad y km; ±40 % cubre la escala |
| Kilometraje | 15 | Km frente a los esperados por edad (15.000 km/año); ±100 % cubre la escala |
| Antigüedad | 10 | Lineal: 0 años = 100, 15 años = 0 |
| Potencia | 5 | Rampa lineal: 50 CV o menos = 0, 250 CV o más = 100 |
| Cambio | 5 | Automático = 100, manual = 0, otros = 50 |
| Bajada de precio | 5 | Desde el primer precio visto; −10 % = 100 |
| Frescura del anuncio | 5 | Recién publicado = 100; a los 60 días = 0 |

La curva de depreciación por defecto es la media del mercado español (≈ −20 %
el primer año, ~−10 % anual hasta el quinto, más suave después), con ajuste de
±1,5 % por cada 10.000 km de desvío sobre el kilometraje esperado.

El ancla del valor esperado es el `reference_price` curado de la versión y, si
falta —que es lo normal en catálogo scrapeado—, el **PVP estimado del
mercado**: la mediana de `precio / residual(edad)` de las ofertas activas del
binomio, es decir, la curva invertida. Con esa ancla la señal funciona como una
comparación de mercado ajustada por edad y kilometraje, que es justo lo que a
la mediana simple se le escapa cuando conviven años muy distintos.

**Transparencia y edición.** Cada oferta devuelve `score_breakdown`: señal a
señal, su valor, su subscore, el **peso final** ya renormalizado y los puntos
que aporta (`sum(points) == value_score`). Los pesos y parámetros se leen en
`GET /scoring/config` (con la explicación generada de los propios parámetros)
y se editan en `PUT /scoring/config` o desde **Ajustes** en la UI; el cambio
aplica a todo el catálogo porque la puntuación se calcula al leer.

---

## Agente de IA

`backend/app/services/ranking_agent.py`. Loop agéntico sobre la Messages API de
Anthropic (`claude-opus-5`) con cuatro tools:

| Tool | Qué hace |
|---|---|
| `get_market_stats` | Mediana, mín/máx, km y año medios, nº de dealers y de versiones |
| `list_offers` | Ofertas candidatas con su versión y todas sus métricas ya calculadas |
| `get_offer_price_history` | Historial de precios de una oferta |
| `submit_ranking` | **Terminal.** Entrega el ranking con salida estructurada (`strict: true`) |

Decisiones que merecen explicación:

- **El run es del binomio marca-modelo, no de la fila de `car_models`.** El
  catálogo está partido por acabado, así que rankear «Audi A3 Sportback 35 TDI»
  era rankear una oferta contra sí misma: sale un ranking de un elemento y un
  «vs mediana» del 0,0 % que compara un coche consigo mismo. El agente compara
  ahora las 27 ofertas del Audi A3, vengan de la versión que vengan, que es el
  conjunto en el que elige un comprador. Cada oferta lleva su `version` y el PVP
  de esa versión, y el prompt le dice explícitamente que la versión explica parte
  de la diferencia de precio: un RS3 por encima de la mediana del A3 puede seguir
  siendo buena oferta.
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

El run es asíncrono: `POST /car-model-groups/rank?key=audi|a3` responde `202` y
el frontend hace polling sobre `GET /ranking-runs/{id}`.

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
| `GET` | `/offers` | Paginado. Filtros: `q`, `car_model_id`, `dealer_id`, `condition`, `fuel_type`, `min_price`, `max_price`, `max_mileage_km`, `min_year`, `max_year`, `tracked_only`, `favorites_only`, `status`. `sort` (el prefijo `-` es descendente): `price`, `-price`, `year`, `-year`, `mileage_km`, `-mileage_km`, `first_seen_at`, `-first_seen_at`, `-last_seen_at`, y `value_score` / `ai_score`, que solo van de mejor a peor y evalúan hasta 500 filas |
| `GET` | `/offers/stats` | Agregados **del conjunto filtrado**: recuento, modelos distintos, precio medio, km medios, km/año medios, descuento medio, mejor chollo y los dominios `price_floor`/`price_ceiling` y `year_floor`/`year_ceiling` |
| `GET` | `/offers/{id}` · `/offers/{id}/price-history` | Detalle e historial |
| `GET` | `/offers/{id}/raw` | Payload crudo del scraper. **No** va en `OfferRead`: 50 payloads por página es peso que casi nadie mira |
| `PATCH` | `/offers/{id}` | **Corrección manual.** Escribe solo los campos que vienen en el cuerpo y los ancla para que el scraper no los pise |
| `DELETE` | `/offers/{id}` | **Descarte manual** (borrado lógico) |
| `POST` | `/offers/{id}/restore` | Deshace el descarte |
| `POST`/`DELETE` | `/offers/{id}/favorite` | Marca / desmarca favorito. Idempotentes; devuelven la oferta |

`/offers/stats` comparte los filtros con `/offers` a través de la misma
dependencia (`OfferFilters`), no de dos listas de parámetros copiadas: si
divergieran, las métricas de cabecera describirían un conjunto distinto del que
enseña la tabla, que es el error que hace inútil una métrica. Las medias salen
de un `AVG` en SQL sobre el conjunto entero; el `best_deal` no, porque la
puntuación de valor se calcula en Python, así que se acota igual que el orden
por puntuación (500 ofertas) y con el mismo criterio, para que coincida con la
primera fila de la tabla.

`price_floor`/`price_ceiling` y `year_floor`/`year_ceiling` son la excepción a
esa regla y lo único de `/offers/stats` que **no** describe el conjunto que se
ve: cada par se calcula con su propio filtro quitado (`min_price`/`max_price` y
`min_year`/`max_year`). Son el dominio de los deslizadores del frontend, y si se
recalcularan con el filtro puesto, el carril se encogería a la propia selección
en cada arrastre y no habría vuelta atrás. Los demás filtros sí cuentan,
incluido el del otro rango: acotar a un modelo, o al precio, sí debe encoger el
carril de los años.

El descarte es lógico a propósito: el scraper vuelve a ver la oferta en el
origen y **no debe resucitarla**. Una oferta `expired` sí se reactiva si reaparece.

`PATCH /offers/{id}` corrige a mano lo que el scraper trajo mal o no trajo:
`title`, `price`, `original_price`, `currency`, `year`, `mileage_km`, `power_hp`,
`condition`, `fuel_type`, `transmission`, `location`, `image_url`, y la
atribución (`car_model_id`, `dealer_id`). Fuera quedan `url` —es la clave del
upsert: cambiarla no corregiría esta oferta, crearía otra— y la procedencia
(`external_id`, `source`, `raw`), que existe justamente para depurar el scraper.

Dos reglas gobiernan el endpoint:

- **Solo se escribe lo que viaja.** El cuerpo se lee con `exclude_unset`, así que
  no mandar `year` lo deja como está y mandar `year: null` lo borra. El
  formulario del frontend manda el diff, no sus catorce campos.
- **Lo que se corrige queda anclado.** Cada campo del cuerpo entra en
  `offers.manual_fields`, y `upsert_offer` deja de escribirlo en los siguientes
  pases del scraper. Sin esto, corregir un año duraría hasta el rastreo de esa
  noche. `{"clear_manual": true}` suelta todos los anclajes —los valores se
  quedan, el scraper vuelve a mandar en ellos—, que es la salida para una
  corrección que ya no hace falta o que estaba mal.

No hay nada que recalcular al guardar: las métricas y `value_score` se computan
al leer, así que la respuesta del `PATCH` ya trae el km/año, el valor esperado y
la puntuación rehechos. El veredicto del agente **no** se rehace: es de un run
pasado y se hizo con los datos de entonces. Corregir el precio anota un punto en
`offer_price_history`, para que el último punto de la serie y la cifra de la
ficha no digan cosas distintas.

Los favoritos son **por usuario**: `OfferRead.is_favorite` es la marca de quien
hace la petición, no un atributo de la oferta. Por eso viven en su propia tabla
y no como columna de `offers`, que es compartida y la escribe el scraper.

### Analítica
| Método | Ruta | |
|---|---|---|
| `GET` | `/analytics/segments` | Agregados por **binomio marca-modelo**. Mismos filtros que `/offers`, más `keys` (los binomios con detalle, máx. 3) |

La unidad de análisis **no** es `car_models`: el catálogo se fragmenta por
acabado —un «Audi A4 Allroad Quattro» son once filas, una por versión— y comparar
a ese nivel no responde nada, porque las medianas salen de dos ofertas. Los
binomios se agrupan por `lower(make)` + `lower(model)`, que además une la misma
marca escrita de varias formas («A4 Allroad Quattro» y «A4 Allroad quattro»), y
la etiqueta sale del `mode()` de las grafías, no de la que gane alfabéticamente.

Todos los binomios traen sus agregados —los pide el selector— pero solo los de
`keys` traen el detalle pesado (nube de puntos, precio por año, stock por dealer,
composición). Mandar la nube de treinta binomios sería pesar de más por algo que
nadie mira.

El reparto entre SQL y Python es el mismo de `/offers/stats`: los percentiles,
las medias y los recuentos describen el **conjunto filtrado entero**; lo que
depende de `value_score` se calcula en Python, va acotado a 600 ofertas por
binomio y lo dice en `offers_sampled`, para que no se lea como si describiera
todo el segmento.

`trend` es la regresión de precio sobre kilómetros del binomio. Se calcula en el
backend para que la cifra de la tabla y la recta del gráfico sean la misma
cuenta, y viaja con su `r2` a propósito: con ocho ofertas una pendiente puede ser
puro ruido, y una pendiente sin su ajuste es un número que aparenta saber algo.

### Catálogo, seguimiento y ranking
| Método | Ruta | |
|---|---|---|
| `GET`/`POST`/`PATCH` | `/car-models` | Modelos con stats de precio, `is_tracked` y el bloque `tracking` (los criterios del usuario) |
| `GET` | `/car-models/groups` | Lo mismo por **binomio marca-modelo**, con las versiones colgando. Filtros: `q`, `tracked_only`, `include_inactive` |
| `GET`/`POST`/`PATCH`/`DELETE` | `/tracked-models` | Modelos a seguir, con precio objetivo, km máx., año mín. y notas |
| `POST`/`DELETE` | `/tracked-models/bulk` | Los mismos criterios sobre varias versiones a la vez, en una transacción |
| `GET`/`POST`/`PATCH` | `/dealers` | Dealers con agregados. Filtros: `q`, `include_inactive` |
| `POST` | `/car-model-groups/rank?key=` | Lanza el agente sobre el binomio → `202` |
| `GET` | `/car-model-groups/ranking?key=` | Último ranking completado del binomio |
| `GET` | `/ranking-runs/{id}` | Estado de un run (polling) |
| `GET` | `/stats/overview` · `/stats/car-models/{id}` | Métricas de cabecera |
| `GET`/`PUT` | `/scoring/config` | Pesos y parámetros de la puntuación de valor, con la explicación de cada señal. El `PUT` es parcial y aplica a todo el catálogo al instante |

`POST /tracked-models` acepta el modelo de dos formas: `car_model_id` si ya está
en el catálogo, o `make` + `model` (+ `trim`) para **crearlo en la misma
llamada**. Seguir un modelo que todavía no existe no debería ser un flujo de dos
pasos con un 409 en medio. Re-seguir un modelo ya seguido actualiza sus criterios
en lugar de fallar.

`GET /car-models/groups` es la vista Modelos. `car_models` está partido por
acabado —un «Audi A3» son veintitrés filas— y a ese nivel casi cada fila tiene
una sola oferta, con mínimo, mediana y máximo iguales: tres columnas para decir
un precio. Agrupa por `lower(make)|lower(model)`, la misma clave que
`/analytics/segments`, así que además une las grafías que solo difieren en
mayúsculas («A4 Allroad Quattro» y «A4 Allroad quattro»). Los precios se calculan
sobre todas las ofertas del binomio, no componiendo los de cada versión: la
mediana de un conjunto no sale de las medianas de sus partes, ni los dealers
distintos de sumar los de cada una. El filtro `q` selecciona **binomios
enteros** —buscar «sportback» devuelve el A3 completo, sus veintitrés
versiones—, porque un grupo recortado daría una mediana que no es la del mercado
que dice describir.

`/tracked-models/bulk` existe porque el seguimiento vive en `car_models`: seguir
un binomio son veintitrés seguimientos, y van en una llamada y no en veintitrés.
El `DELETE` lleva los ids en `car_model_ids` separados por coma y es idempotente
—se dispara sobre un binomio del que normalmente solo algunas versiones estaban
seguidas—. El PVP de referencia no se toca en lote a propósito: es de la versión,
y un RS3 no comparte precio de catálogo con un 1.0 TFSI.

---

## Frontend

React + Vite + TypeScript, CSS propio con tokens (sin framework de UI).
Estética minimalista inspirada en Twenty CRM: sidebar plegable, tabla densa de
registros con cabecera *sticky*, chips de color suave, un único azul de acento
y radios de 4 px.

La única excepción al «sin framework» son los **gráficos**: la vista de Analítica
usa el componente `chart` de shadcn/ui sobre Recharts, que está escrito con
clases de Tailwind. Tailwind entra por eso y solo por eso, y entra **sin su
`preflight`** (`src/tailwind.css` importa `theme` y `utilities`, no el reset):
el reset pisaría la tabla, los botones y los formularios que ya existen. El
bloque `@theme` traduce los tokens de `styles.css` a los nombres que espera
shadcn, así que si cambia la paleta de la app los gráficos la siguen. Y como el
CSS propio va sin capa, siempre gana a las utilidades de Tailwind sin necesidad
de un solo `!important`.

La sidebar se pliega a un riel de iconos de 52 px con el botón `«` o con
**⌘/Ctrl+B**, y la preferencia se guarda en `localStorage`: la tabla de ofertas
tiene catorce columnas y esos 172 px de más se notan. Plegada, los `title` y los
`aria-label` son la única etiqueta de cada icono. Por debajo de 860 px la sidebar
sigue oculta, como antes.

| Vista | |
|---|---|
| **Ofertas** | Tabla principal (marca / modelo / versión, ubicación, precio, km, km/año, métricas, filtros, orden, favoritos ★, descarte), panel de detalle con todo lo scrapeado y editor para corregir a mano lo que vino mal |
| **Analítica** | Hasta tres binomios marca-modelo comparados en seis gráficos y un cuadro de dieciséis métricas |
| **Modelos** | Una fila por binomio marca-modelo, desplegable en sus versiones. Panel único de seguimiento (elegir del catálogo o crear al vuelo + criterios) y panel de ranking IA con pros/cons y traza de tools |
| **Dealers** | Agregados por concesionario, con edición y aviso de duplicados |
| **Ajustes** | API keys y contrato de ingesta |

Dos decisiones de interacción que no son obvias:

- **Las métricas de cabecera son las del filtro, no las del catálogo.** Piden
  `/offers/stats` con los mismos filtros que la tabla, así que «precio medio»
  significa el de las filas que se están viendo. Enseñar la media global junto a
  una tabla filtrada es enseñar dos conjuntos distintos como si fueran uno. No
  son tarjetas: son contexto de la tabla, y el «mejor chollo», que es una oferta
  concreta y no un agregado, se separa con un filete y abre su panel.
- **Hay dos «vs mediana» y no son la misma.** La del panel de detalle es
  `price_vs_median_pct`: mediana de **todas** las ofertas activas del binomio
  marca-modelo, la que alimenta `value_score` y al agente de IA. Es del binomio y
  no de la fila de `car_models` por la misma razón que el resto: con una oferta
  por acabado, la mediana de la versión es el precio del propio coche y salía un
  0,0 % que decía «justo en mercado» comparándolo consigo mismo, con
  `value_score` clavado en la mitad de la escala. La de la **tabla** se
  calcula en el navegador sobre las filas que hay en pantalla y responde otra
  pregunta: «de lo que estoy mirando, ¿cuál sale barato?». Por eso se mueve al
  filtrar y al cambiar de página, y por eso la cabecera de la columna enseña la
  mediana con la que compara: un porcentaje sin su referencia no dice nada. Con
  menos de dos filas no hay dato (la mediana sería el propio precio y saldría un
  0,0 % que parece «justo en mercado» sin serlo). La del panel lleva «del
  modelo» debajo para que no se confundan.
- **El dealer no tiene columna, la ubicación sí.** Los nombres reales llegan a 38
  caracteres («Flexicar Móstoles - Polígono Regordoño») y se comían el ancho para
  algo que casi nunca decide una compra; el dealer sigue en el filtro, en el panel
  de detalle y en su propia vista. La columna **Ubicación** usa `location` de la
  oferta y cae a la ciudad del dealer cuando el scraper no la manda.
- **Marcar un favorito no recarga la tabla.** Se parchea la fila con la oferta que
  devuelve el endpoint, para no perder la posición ni el orden mientras se marcan
  varias seguidas.
- **La tabla enseña la identidad, el panel enseña el resto.** Las columnas son
  marca / modelo / versión: lo que sirve para comparar de un vistazo. El descuento,
  el estado del vehículo, los días publicada, el historial de precios y el `raw`
  del scraper viven en el panel de detalle, que **abre la fila entera** (con
  `stopPropagation` en la estrella y en el botón de descartar) y los pide bajo
  demanda.
- **El panel de detalle responde una pregunta, no vuelca un esquema.** La
  pregunta es «¿merece la pena abrir esto?», así que el orden no es el de la
  tabla `offers` sino el de la decisión: una franja de **veredicto** arriba del
  todo (precio, PVP tachado, descuento, las cuatro desviaciones, la puntuación de
  valor y el veredicto del agente), la **evidencia** debajo a dos columnas (foto y
  ficha del coche y del dealer), y la **procedencia** plegada al final (fuente,
  IDs, fechas de scrapeo, `raw`), que es dato de diagnóstico y no de decisión. El
  `raw` solo se pide al desplegarlo.
- **Corregir una oferta se hace desde su ficha, y lo corregido queda marcado.**
  El botón «Corregir» está en la cabecera del panel de detalle y no en la fila:
  los datos malos se descubren leyendo la ficha —o el anuncio, que se abre desde
  ella—, nunca barriendo la tabla, y en la fila habría sido un tercer icono de
  24 px compitiendo con los dos que sacan la oferta de la lista. Es el mismo
  formulario en dos superficies: en escritorio un panel de 880 px con los campos
  a tres columnas, encima de la ficha y del mismo ancho para taparla entera; en
  un móvil una hoja inferior a una columna, con teclado numérico en las cifras y
  la lista de versiones como buscador + opciones de 44 pt, porque un `<select>`
  de ciento setenta y ocho acabados es una rueda que hay que girar a ciegas. Los
  campos que lleva la mano salen con la marca **a mano** en su rótulo, y al pie
  del formulario está la salida («Devolver al scraper»): un anclaje sin salida es
  una decisión de hoy que sobrevive a la fuente para siempre. La ficha, además,
  anota en «Procedencia» cuántos campos se corrigieron y cuándo, porque eso es
  justamente lo que dice qué parte de la ficha no viene del anuncio.
- **El preview del anuncio no es un iframe.** Los portales de coches sirven
  `X-Frame-Options`/`frame-ancestors` y saldría en blanco. La columna izquierda del
  panel monta la vista con lo que sí tenemos scrapeado —`image_url`, titular,
  dealer— y la tarjeta entera enlaza al anuncio original. El precio no se repite
  ahí: lo dice la franja de veredicto, justo encima. Requiere que el scraper mande
  `image_url`; si falta o la foto ya no responde, cae a un hueco que lo dice.
- **Seguir un modelo es un solo paso.** Antes había que crear el modelo, buscarlo
  en la tabla y pulsar «Seguir», y los criterios (`target_price`, km, año, notas)
  no había forma de tocarlos desde la UI. Ahora el panel «Seguir un modelo» /
  «Criterios» hace las dos cosas a la vez. La columna **Objetivo** marca en verde
  el modelo cuya oferta más baja ya está por debajo del precio objetivo.
- **La fila de Modelos es el binomio, no el acabado.** Un «Audi A3» son
  veintitrés filas de `car_models`, así que la tabla enseñaba veintitrés líneas de
  una oferta cada una, con mínimo, mediana y máximo iguales: tres columnas para
  decir un precio. Ahora la fila es «Audi A3» con los precios de sus veintisiete
  ofertas, calculados en el servidor (`/car-models/groups`), y se despliega en sus
  versiones. La jerarquía se lleva en la primera columna —sangría y registro más
  ligero— y no tiñendo la fila: las versiones tienen las mismas cifras que su
  binomio, así que lo que hay que distinguir es de quién es cada número, no
  separar dos tablas.
- **«Seguir» y «Ranking IA» son del binomio; los criterios se pueden afinar por
  versión.** El seguimiento se aplica en lote —es la pregunta real: «avísame si
  algún A3 baja de 18.000 €»— y el botón enseña `4/11` cuando solo algunas están
  seguidas, en cuyo caso el clic las suelta todas en vez de completar un
  seguimiento que nadie ha pedido. El PVP de referencia no viaja en lote: es de
  la versión, y por eso «Criterios» sigue existiendo en las filas desplegadas.
  La columna **Último ranking** solo tiene dato en la fila del binomio, que es de
  quien es el run.

### Analítica

Seis gráficos y un cuadro, todos sobre la misma selección. La nube de puntos va
primera porque es la que decide una compra; el resto la acota (dónde está el
precio, de qué años, de quién):

| | Responde |
|---|---|
| **Precio vs kilómetros** | Lo que cae por debajo de su propia recta está barato *para el uso que lleva*, que no es lo mismo que ser el más barato de la lista |
| **Rango de precio** | Caja y bigotes: mín · P25 · mediana · P75 · máx. Dónde está cada binomio y cuánto se dispersa |
| **Depreciación por año** | Mediana por año de matrícula. Lo que cuesta cada año de antigüedad |
| **Distribución de precio** | Ofertas por tramo. Dónde hay masa hay con qué negociar |
| **Composición** | Reparto por combustible / cambio / estado, en % porque los binomios tienen tamaños distintos |
| **Dealers con más stock** | A quién hay que mirar |
| **Cuadro comparativo** | Las dieciséis métricas exactas, y el equivalente accesible de todo lo anterior |

Lo que no es obvio:

- **Tres binomios, y el tope no es estético.** Son las ranuras de color que la
  paleta puede separar bajo daltonismo con *todos* los pares en juego, que es lo
  que exige una nube de puntos (en una serie de barras basta con los pares
  adyacentes). Con un cuarto color no hay orden que supere el umbral, así que el
  selector corta ahí en vez de pintar algo que no se puede leer. Las tres tintas
  se eligieron con un validador, no a ojo: separación bajo daltonismo ΔE 9,9 ·
  visión normal ΔE 27,2 · contraste ≥ 3:1 sobre blanco.
- **El color sigue al binomio, no a su posición.** Cada uno se queda con su
  ranura hasta que se le quita, así que deseleccionar otro no repinta los que
  quedan: quien aprendió que el Audi es azul lo sigue viendo azul. Y si un
  binomio desaparece del catálogo entre dos cargas —se descarta su última oferta,
  o lo excluye un filtro— su ranura se libera sola; si no, quedaría ocupada por
  algo que ya no se ve y que no habría forma de quitar.
- **La recta solo se dibuja si ajusta (R² ≥ 0,15).** Con pocas ofertas una
  pendiente es ruido con aspecto de conclusión. Cuando no llega, el pie del
  gráfico lo dice con esas palabras en vez de callarse.
- **La composición va en porcentaje y en barras agrupadas.** En recuento no se
  puede comparar un binomio de veinticuatro ofertas con uno de diez; y en barras
  el color sigue siendo el del binomio, así que no hay que inventar una paleta
  para siete combustibles —que además no se distinguirían—.
- **En una recarga se mantiene lo pintado a media tinta.** Un esqueleto en cada
  cambio de filtro salta la página entera de sitio, y eso se nota más que el
  retardo.

Desarrollo con recarga en caliente (proxy a `localhost:8000`):

```bash
cd frontend && pnpm install && pnpm dev
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

- `smoke_api.py` (114 comprobaciones) recorre la API end-to-end contra el stack en
  marcha: autenticación, ingesta con API key, métricas, filtros, orden, descarte,
  favoritos (incluido que son por usuario), seguimiento con criterios, edición de
  dealers y que el `raw` se sirve aparte y no cuela en el listado. La corrección
  manual va entera: que solo se escriba lo que viaja, que lo corregido sobreviva
  al siguiente pase del scraper mientras el resto sí se actualiza, que el precio
  corregido se anote en el historial, y que soltar los anclajes devuelva la
  columna al origen sin borrar el valor. Es idempotente.
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
