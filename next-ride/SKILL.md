---
name: daily-car-scan
description: Rutina diaria para recorrer pares de modelo y dealer, buscar ofertas públicas mediante fetch, Playwright o navegador, normalizarlas, deduplicarlas y enviar las nuevas o las que cambian de precio a la API. Usar para captar stock de Flexicar, coches.net, OcasionPlus, Iruri Motor, Quadis y otros portales configurados, y terminar escribiendo un informe del run.
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

## 0.1 Preflight de herramientas — lo primero del run

Antes de cargar la configuración y antes de tocar la red, mira la **lista de herramientas
de esta sesión** y anota qué hay realmente disponible:

| Capacidad | Cómo se comprueba | Sin ella no puedes |
|---|---|---|
| `fetch` | Existe `WebFetch`, o `curl`/`python3` con salida a internet | Nada: si tampoco hay esto, **aborta el run**. |
| `playwright` | Existe una herramienta MCP de Playwright en la lista de tools | Servir targets con `access: playwright`. |
| `browser` | Existe una herramienta de navegador real (`mcp__Claude_Browser__*`, `mcp__claude-in-chrome__*`, o equivalente) | Servir targets con `access: browser` y descubrir `search_url` nuevos. |

Comprobar significa **mirar la lista de herramientas**, no llamar a una a ver si falla.

Reglas duras del preflight, sin excepciones:

- Si no hay herramienta de Playwright ni de navegador, todos los targets con
  `access: playwright` o `access: browser` salen del run **inmediatamente** con estado
  `tooling_unavailable`. No los abras, no los reintentes, no busques un rodeo.
- **No instales un navegador ni te lo fabriques.** Nada de `npx playwright install`,
  `pip install playwright`, descargar Chromium, levantar Chrome headless a mano, hablar
  CDP por tu cuenta ni pelearte con el proxy TLS del entorno. Si la herramienta no está
  en la lista, para esta sesión no existe.
- Si te descubres depurando la instalación de un navegador o errores de certificado del
  proxy, eso ya no es este run. Corta, marca los targets afectados como
  `tooling_unavailable` y sigue con los de `fetch`.
- Deja el resultado del preflight en la cabecera del informe: qué había, qué no, y qué
  targets quedan fuera por ello. Es lo que le dice a un humano que hay que arreglar el
  runner, no el scraper.

El inventario se hace ahora; se aplica en cuanto llegue la config del §1, cribando los
targets por `source.access` antes de abrir el primer portal.

Un run con los targets de navegador en `tooling_unavailable` y los de `fetch` en `ok` es
un run **correcto** y debe terminar con éxito.

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

### 1.1 `search_url: null`: primer descubrimiento y régimen estacionario

Un `search_url` a `null` no es un error de configuración: es un target que todavía no ha
pasado por su **primer descubrimiento**. Distingue los dos momentos, porque tienen costes
y requisitos distintos:

- **Primer descubrimiento (una vez por target).** coches.net y OcasionPlus solo entregan
  la URL de búsqueda tras interacción real con la interfaz: escribir en el buscador,
  elegir una sugerencia del desplegable y aceptar. Eso **no es fetchable por naturaleza**;
  no hay URL construible que reproduzca el resultado. Necesita Playwright o navegador.
- **Régimen estacionario (todos los demás runs).** El `PATCH` persiste la URL y los IDs,
  así que los runs siguientes leen `search_url` ya resuelto de la API y no descubren nada.
  El coste de interacción se paga una sola vez, no cada día.

Según lo que haya:

- Con `playwright` o `browser` **disponibles en el preflight**: descubre la URL desde la
  interfaz pública y guárdala con `PATCH /api/v1/scraping/targets/{target.id}` antes de
  seguir con ese target.
- Con `playwright` o `browser` **no disponibles**: el target sale como
  `tooling_unavailable`. No es `configuration_missing` (la config está bien) ni `blocked`
  (el portal no nos ha rechazado): falta nuestra herramienta. Mañana, con navegador, se
  descubre y se persiste.
- Con `fetch` o `manual`: marca el target como `configuration_missing` y continúa. Las
  fuentes con plantillas de slug deben llegar ya resueltas desde la API.

**Nunca adivines URLs de slug como sustituto del descubrimiento.** Probar rutas
plausibles en coches.net ha devuelto redirecciones a `http://127.0.0.1`, que tiene toda
la pinta de ser la respuesta de un WAF a tráfico sospechoso. Adivinar genera exactamente
el patrón de peticiones que te marca como bot, y el precio no lo paga el target de hoy:
lo paga la fuente entera en los runs que sí tienen navegador. Un `tooling_unavailable`
cuesta un target un día; que te señalen la IP cuesta la fuente.

## 2. Elegir herramienta según el dealer

El campo `source.access` devuelto por la API manda. No lo cambies por tu cuenta. Y solo
se intenta lo que el preflight (§0.1) haya declarado disponible.

| access | Qué usar | Cuándo | Si la herramienta no existe en la sesión |
|---|---|---|---|
| `fetch` | `WebFetch` o `curl` | El sitio renderiza en servidor y su robots.txt permite la ruta. Es el caso de Flexicar. Empieza siempre por aquí: es lo más rápido y barato. | Aborta el run: sin fetch no hay nada que hacer. |
| `playwright` | Playwright MCP, con navegador como fallback | El listado se pinta por JS. Espera el selector del listado, no un `sleep` fijo. Si Playwright falla o es bloqueado en dos intentos, prueba el navegador real antes de marcar el target como `blocked`. | Sin Playwright **ni** navegador: `tooling_unavailable`, sin abrir el portal. |
| `browser` | Navegador real del usuario | Cuando hace falta una sesión normal del navegador o Playwright no puede leer el listado. Si el navegador responde pero no carga en dos intentos, marca el target como `skipped` y continúa. | `tooling_unavailable`, sin abrir el portal. |
| `manual` | Nada | El sitio prohíbe el acceso automatizado. **No lo scrapees.** Márcalo como `blocked_by_policy` en el informe y pasa al siguiente. | — |

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

## 2.1 `blocked` vs `tooling_unavailable`: no son lo mismo

Dos fallos que se parecen mucho en pantalla y que se arreglan en sitios opuestos. Clasifica
siempre a conciencia, porque el informe es lo único que ve quien tiene que reaccionar:

| | `tooling_unavailable` | `blocked` |
|---|---|---|
| Qué ha pasado | Nuestro runner no tenía con qué mirar: no hay herramienta de Playwright/navegador, o la salida a red falla (proxy TLS, `ERR_CONNECTION_RESET`, DNS) | El portal nos ha rechazado activamente: 403, 429, muro de captcha, challenge de WAF, tarpit |
| Quién lo arregla | Quien mantiene el runner o el entorno de ejecución | Escalado técnico o legal con el dealer |
| Qué NO hay que hacer | Reintentar mañana esperando suerte | Insistir, rotar identidad o buscar rodeos |

Desambiguador rápido: si **todos** los targets de **dominios distintos** fallan igual, el
problema es nuestro (`tooling_unavailable`). Si un dominio falla mientras otros van bien
con la misma herramienta, el problema es de ese dominio (`blocked`).

## 2.2 Confirmar que la página cargó de verdad

Un `<title>` no es prueba de nada. **La página de error de red de Chrome pone el hostname
solicitado como `<title>`**, así que `document.title === "www.coches.net"` se lee exactamente
igual tanto si el listado ha cargado como si la conexión se ha caído. Es la trampa más cara
de este run: parece que funcionó y no funcionó.

No aceptes ninguno de estos como señal de éxito: el `<title>`, la URL de la barra de
direcciones, un screenshot no vacío, o un HTTP 200 a secas.

**Exige siempre una aserción de contenido** antes de tratar una captura como buena: el
selector propio de ese listado tiene que existir con al menos un elemento. Y comprueba
además las señales negativas:

- `#main-frame-error`, `.error-code` o `chrome-error://chromewebdata` en la página;
- texto `ERR_CONNECTION_RESET`, `ERR_TIMED_OUT`, `ERR_NAME_NOT_RESOLVED`, `ERR_PROXY_*`,
  `ERR_CERT_*`;
- `document.body.innerText` por debajo de unos cientos de caracteres en un listado que
  debería traer decenas de tarjetas.

En `fetch` vale lo mismo: un 200 con cuerpo de challenge o de interstitial no es un
listado. Asegúrate de que aparece el marcador esperado (`__NEXT_DATA__`, `results[]`)
antes de dar la respuesta por buena.

Qué hacer con una aserción fallida: un reintento y, si vuelve a fallar, clasifica según
§2.1 — un `ERR_*` de red o de proxy es **nuestro** (`tooling_unavailable`); un 403, un
captcha o un challenge es **suyo** (`blocked`). Guarda la captura fallida para poder
diagnosticarla y no la normalices.

Comprueba la aserción también en las páginas de control, no solo en el objetivo: dar por
bueno un `example.com` que en realidad era la interstitial de error es cómo se pierde
media sesión persiguiendo el problema equivocado.

## 2.3 Recetas de acceso por dealer

Usa estas recetas mientras la fuente conserve el mismo `source.access` en la API.
No redescubras una fuente o sus selectores en cada run.

La columna de aserción es la de §2.2: si ese marcador no aparece, la carga **no** cuenta
como buena, diga lo que diga el `<title>`.

| Dealer | Acceso | Fuente estable | Aserción de carga | Salida determinista |
|---|---|---|---|---|
| Flexicar | `fetch` | `__NEXT_DATA__` + endpoint `/vehicles` configurado por la API | `<script id="__NEXT_DATA__">` con `props.pageProps.initialVehicles` | `scrapers/flexicar.py` |
| coches.net | `playwright` | tarjetas del listado público | `.mt-ListAds-item.mt-CardAd` (≥ 1) | captura browser + `scrapers/cochesnet.py` |
| OcasionPlus | `playwright` | tarjetas con atributos `data-test` | `a[href*="/coches-segunda-mano/"]` (≥ 1) | captura browser + `scrapers/ocasionplus.py` |
| Iruri Motor | `fetch` | endpoint JSON público de Vehica | JSON con `results[]` | `scrapers/irurimotor.py` |
| Quadis | `browser` | tarjetas `.car-card` del listado público | `.car-card` (≥ 1) o `#vehicle-count` a cero | captura browser + `scrapers/quadis.py` |
| Compramos Tu Coche | `fetch` | listado SSR con atributos `data-qa-selector` | **chip `[data-qa-selector="filter-item-vehicle"]` que coincida con el token** | `scrapers/compramostucoche.py` |

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

   > **Techo conocido de Flexicar — no lo vuelvas a investigar.** `services.flexicar.es`
   > publica `Disallow: /` en su propio `robots.txt`, así que el endpoint de paginación
   > `api/v1/vehicles` está desautorizado y con `access: fetch` no se puede usar. En la
   > práctica, **los targets de Flexicar están estructuralmente limitados a lo que quepa
   > en la página 1 (12 tarjetas), sea cual sea `max_results`**: con `max_results = 15`
   > eso son 12 de 85 disponibles. Es el comportamiento correcto, no un fallo. El
   > extractor ya lo señala con `pagination_blocked_by_robots`. El target sigue siendo
   > `ok`; el déficit de cobertura se anota como *techo conocido* en el informe y no abre
   > incidencia ni se reintenta por otra vía.
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
2. Si `search_url` es `null`, esto es un **primer descubrimiento** (§1.1): abre la web
   pública, entra en **Marca y modelo**, busca el nombre exacto, selecciónalo y pulsa
   **Aceptar**. No uses el buscador con IA para fijar el modelo: puede interpretar `A3`
   como `A4`. Sin herramienta interactiva no hay atajo: `tooling_unavailable` y a otra
   cosa. No pruebes URLs de slug a ver si suena la flauta — es lo que acaba en una
   redirección a `http://127.0.0.1`.
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

1. Usa Playwright con el `search_url` del target. Si es `null`, es un primer
   descubrimiento (§1.1): construye la búsqueda desde la interfaz pública y persiste la
   URL con el mismo `PATCH` descrito para Coches.net. Sin herramienta interactiva,
   `tooling_unavailable`; tampoco aquí se adivinan slugs.
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

### Quadis

1. Lee `robots.txt`: la ruta pública `/coches/...` es navegable, pero `/*?` está
   desautorizado para fetch. Respeta `source.access=browser`; no descargues por `curl`
   el target de A4 que usa `makeId` y `modelId`.
2. Abre el `search_url` exacto del target en el navegador. A3 y Clase A usan rutas
   semánticas; A4 usa los IDs persistidos por la API. Espera a que exista `.car-card` o
   que `#vehicle-count` confirme cero resultados.
3. Captura en una sola lectura masiva, conservando el orden del portal:
   - URL e imagen: el enlace de `.actions` y `.car-card-img img`;
   - modelo y versión: `h2 strong` y `h2 span`;
   - año, kilómetros y cambio: `.detail-list li`;
   - combustible: `.car-tags .tag`;
   - precio de contado: `.grid-price .cash-label strong`;
   - precio anterior: `.grid-price .previous`, solo cuando sea mayor que el contado;
   - condición: atributo `data-type` de la tarjeta.
4. Guarda la captura compacta en `state/quadis-browser-candidates.json`. Los bloques
   publicitarios también tienen `.car-card`; consérvalos y deja que el normalizador los
   descarte por no tener URL.
5. Exige coincidencia estricta con el target. Para `Audi A4 Allroad quattro`, una tarjeta
   `Audi A4 Avant` no pertenece al modelo aunque el filtro general de Quadis la devuelva.
6. Ejecuta:

```bash
python3 scrapers/quadis.py \
  --snapshot state/quadis-browser-candidates.json \
  --fixture scrapers/fixtures/quadis-browser-candidates.json \
  --config state/runtime-config.json --out-dir state
```

Los vehículos nuevos sin año visible no se publican: `year` es obligatorio para el freno
de validación. No abras fichas individuales solo para completar ese dato; continúa por el
listado hasta reunir `max_results` ofertas válidas o agotar tres páginas.

### Compramos Tu Coche

`robots.txt` solo desautoriza `/home-service/`, `/inspection/`, `/appointment/` y
similares: `/comprar-coche/` es navegable con `fetch`.

1. El listado se renderiza en servidor, pero **las clases CSS llevan hash**
   (`root___Dz4kU`, CSS-modules) y cambian en cada despliegue. Selecciona solo por
   `data-qa-selector`; no escribas nunca un selector de clase para esta fuente.
2. **La trampa de este portal: un filtro inválido no da error.** Los parámetros no usan
   el nombre que muestra la interfaz:
   - `brand` lleva guion bajo donde el nombre lleva guion: `MERCEDES_BENZ`, no
     `MERCEDES-BENZ`;
   - `model` es `{BRAND}.{TOKEN}` y el token es el nombre interno **en alemán**:
     `A-KLASSE` (no `CLASE A`), `PAJERO` (no `MONTERO`).

   Con un token equivocado el sitio responde **HTTP 200 con el catálogo entero sin
   filtrar**: diez tarjetas sanas de Toyota, Seat o MINI que parecen un listado
   correcto del target. Por eso la aserción de §2.2 aquí no es opcional: exige el chip
   `[data-qa-selector="filter-item-vehicle"]` y que su parte de modelo **coincida
   exactamente** con el token pedido. Sin chip, o con un chip que solo trae la marca,
   el listado se descarta entero. `assert_filter_applied()` ya lo hace.
3. Cada carrocería es un modelo distinto y **repetir `model` en la URL no combina
   nada** (se queda con el primero). Por eso el target lleva
   `search_params.model_tokens` y el extractor los recorre en el orden del portal
   hasta completar el cupo. `Audi A3` necesita `A3`, `A3 SPORTBACK`, `A3 LIMOUSINE` y
   `A3 ALLSTREET`; `Mercedes Clase A` necesita `A-KLASSE` y `A-KLASSE LIMOUSINE`.
4. La página trae 10 tarjetas y pagina con `&page=N`; el tope son 3 páginas por token,
   y se corta en cuanto se reúnen `max_results`.
5. Campos por tarjeta, todos por `data-qa-selector`: `title` (texto y `href`),
   `registration` (`07/2015` → año), `mileage`, `transmission`, `fuelType`,
   `horsePower` (`140 kW (190 CV)` → 190) y `price`. El precio de contado viene ya en
   entero en `data-qa-selector-value`; **`monthly-price` es la cuota financiada y no se
   usa nunca**.
6. El anuncio se publica en compramostucoche.es pero el enlace apunta a
   **autohero.com**, la marca de retail del mismo grupo y el vendedor real: `dealer_name`
   es `Autohero`. Quita el parámetro `MID` de tracking; la URL limpia
   (`/es/{modelo}/id/{uuid}/`) es la clave natural y el `uuid` es el `external_id`.
7. `image_url` se queda vacío a propósito: el HTML servido solo trae relleno
   (`defaultTabletImage` o un `data:` en base64), y la foto real la carga el carrusel
   por JS. No es un fallo del extractor y no hay que "arreglarlo" con `fetch`.
8. Ejecuta:

```bash
python3 scrapers/compramostucoche.py "Audi A3" --max 15 \
  --config state/runtime-config.json \
  --fixture scrapers/fixtures/compramostucoche-audi-a3-listing.html \
  --out state/raw-compramostucoche-audi-a3.json
```

Cero ofertas con el chip correcto es un resultado válido, no un `layout_changed`:
significa que ese modelo no tiene stock hoy. Es el caso habitual de `Mercedes Clase A`
y `Mitsubishi Montero` en esta fuente.

### Secuencia común después de capturar

0. Comprueba la aserción de contenido de §2.2 **antes de nada**. Una captura que no la
   pasa no se normaliza ni se cuenta como listado vacío: se guarda para diagnóstico y el
   target se clasifica según §2.1.
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

El freno solo aplica a listados que **pasaron la aserción de carga** de §2.2. Un cero
sobre una página que ni siquiera cargó no es `layout_changed`: no hay HTML que se haya
roto. Clasifícalo según §2.1 y no toques el fixture ni los selectores.

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

- **Cabecera con el preflight de §0.1**: qué herramientas había, cuáles no, y qué targets
  quedan fuera por ello.
- Tabla por target: dealer, modelo, encontrados, nuevos, con bajada de precio, sin cambios,
  descartados, estado.
- Los cambios de precio del día, con importe y porcentaje.
- El déficit de cobertura por target (`max_results - válidas`) cuando no se complete el
  cupo, con su causa. Los techos estructurales conocidos —Flexicar limitado a la página 1
  por su propio `robots.txt`— se etiquetan como **techo conocido** y no cuentan como
  incidencia.
- Errores y qué habría que arreglar a mano.

Vocabulario de estados. Cada uno apunta a un responsable distinto; esa es toda su razón
de ser:

| Estado | Significa | Lo arregla |
|---|---|---|
| `ok` | Capturado y normalizado, aserción de contenido incluida | — |
| `tooling_unavailable` | Nuestro runner no tenía herramienta o salida a red | El entorno de ejecución |
| `blocked` | El portal nos rechazó activamente (403, 429, captcha, WAF) | Escalado con el dealer |
| `blocked_by_policy` | `robots.txt` o `access: manual` lo desautorizan | Nadie: es la decisión correcta |
| `layout_changed` | Cargó, pero los selectores o el freno de emergencia fallaron | El scraper |
| `configuration_missing` | Falta `search_url` en una fuente que no puede descubrirlo | La config de la API |
| `skipped` | La herramienta estaba y aun así no se pudo completar en dos intentos | Revisar al día siguiente |

`tooling_unavailable` no es un subtipo de `blocked`: un día entero de targets en
`tooling_unavailable` significa que hay que arreglar el runner, y no debe leerse como que
los portales nos están cerrando la puerta.

Termina imprimiendo por stdout un JSON de una línea:
`{"date":"...","targets":N,"sent":N,"new":N,"price_changed":N,"errors":N,"blocked":N,"tooling_unavailable":N}`
para que el cron pueda alertar sin parsear el markdown, y distinguir de un vistazo un
problema nuestro de uno de los portales.

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
