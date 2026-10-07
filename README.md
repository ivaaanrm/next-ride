# next-ride

Agrega ofertas de coches de distintos dealers, calcula métricas de valor y las
rankea con un agente de IA. Corre entero en Cloudflare: un Worker sirve la PWA
y la API desde el mismo origen, con D1 de base de datos y R2 para lo pesado.

```
                 ┌──────────────────── Worker «next-ride» ─────────────────────┐
  iPhone (PWA) ──┤  /            Static Assets (SPA, modo single-page-app)     │
  navegador      │  /api/auth/*  Better Auth (email+contraseña, cookie)        │
                 │  /api/v1/*    Hono: ofertas, métricas, catálogo, analítica  │
  skill ─────────┤  /health      esquema al día (d1_migrations) → 200 / 503    │
  (X-API-Key)    │  cron 03:17   backup de D1 a R2                             │
                 │  Workflow     agente de ranking (un paso por vuelta) ───────┼──▶ Anthropic API
                 └────────┬──────────────────────────────┬─────────────────────┘
                          ▼                              ▼
                    D1 «next-ride»                  R2 «next-ride»
                    (dominio + sesiones)            raw/  payloads del scraper
                                                    backups/  NDJSON.gz diario
```

El scraper es el skill de `next-ride/` (fuera de este proyecto): pide
`GET /api/v1/scraping/config`, persiste lo que descubre con
`PATCH /api/v1/scraping/targets/{id}` e ingesta con `POST /api/v1/offers/bulk`,
siempre con `X-API-Key`. Ese contrato es el mismo de antes del port, y las
claves `nr_<prefijo>_<secreto>` existentes siguen valiendo.

Cada cuenta es un compartimento estanco: el scraper de una clave busca lo que
ha configurado la cuenta dueña de la clave e ingesta en ella, y nadie más ve
esas ofertas (ver [Cuentas y aislamiento](#cuentas-y-aislamiento)).

---

## Arranque local

Requisitos: Node 22+ y pnpm (sale de corepack: `corepack enable`).

```bash
pnpm install
```

```bash
cp .dev.vars.example .dev.vars
```

```bash
pnpm db:migrate:local
```

```bash
pnpm dev
```

`pnpm dev` levanta Vite con el plugin de Cloudflare: la SPA y el Worker corren
juntos en workerd, con D1, R2 y el Workflow locales (en `.wrangler/state`), en
http://localhost:5173. No hay proxy ni CORS que configurar: es el mismo origen,
igual que en producción.

El superusuario de `.dev.vars` (`FIRST_SUPERUSER_EMAIL` /
`FIRST_SUPERUSER_PASSWORD`) se crea solo en la primera petición. Para probar la
ingesta, la clave de `BOOTSTRAP_SCRAPER_API_KEY` queda registrada igual, o se
crea una desde **Más → API keys**.

### Comandos

| Comando | Qué hace |
|---|---|
| `pnpm dev` | SPA + Worker en local |
| `pnpm test` | Pruebas extremo a extremo contra el Worker real (D1/R2/Workflow de Miniflare) |
| `pnpm typecheck` | Tipos del Worker, la SPA, los scripts y las pruebas |
| `pnpm validate:mobile` | Build + auditoría PWA/iOS + presupuestos de peso |
| `pnpm types` | Regenera `worker/worker-configuration.d.ts` desde `wrangler.jsonc` |
| `pnpm db:generate` | Nueva migración SQL desde `worker/db/schema.ts` (drizzle-kit) |
| `pnpm db:migrate:local` / `:remote` | Aplica las migraciones pendientes (Wrangler) |
| `pnpm gen:splash` | Regenera las pantallas de arranque de iPhone desde el icono |
| `pnpm db:import-pg` | Convierte un `pg_dump` de la versión anterior a SQL de D1 |
| `pnpm run deploy` | Build y `wrangler deploy` |

---

## Despliegue

Producción: https://cochesradar.com (y, mientras el skill no cambie de URL,
https://next-ride.iromero-py.workers.dev) — D1 `next-ride` y R2
`next-ride`, ambos en Europa occidental. La base, el bucket, las migraciones y
`BETTER_AUTH_SECRET` ya están creados; lo que queda por poner son los secretos
opcionales, con `pnpm wrangler secret put NOMBRE`:

| Secreto | Para qué |
|---|---|
| `FIRST_SUPERUSER_EMAIL`, `FIRST_SUPERUSER_PASSWORD` | Siembra del primer usuario en la primera petición (el registro está cerrado: `ALLOW_REGISTRATION=false`) |
| `BOOTSTRAP_SCRAPER_API_KEY` | La `NR_API_KEY` que ya usa el skill, para que siga valiendo sin tocarlo. Es del superusuario: ingesta en su cuenta |
| `ANTHROPIC_API_KEY` | El ranking con IA; sin ella responde 503 |

La configuración no secreta (`ALLOW_REGISTRATION`, modelo y esfuerzo del
agente, retención de backups…) está en `vars` de `wrangler.jsonc`.

### Despliegue continuo (Workers Builds)

Se configura en el panel de Cloudflare (Workers → `next-ride` → Settings →
Builds), conectando el repositorio con la rama `main`:

| Campo | Valor |
|---|---|
| Build command | `pnpm install --frozen-lockfile && pnpm build` |
| Deploy command | `pnpm db:migrate:remote && pnpm exec wrangler deploy` |

Las migraciones van **antes** que el código: una migración es aditiva o no se
escribe, así que el código viejo sigue funcionando con el esquema nuevo
mientras dura el despliegue, y el nuevo nunca arranca contra un esquema viejo.
La excepción es `0003_account_isolation.sql`: quita las claves únicas globales
de las que tiraba la ingesta anterior, así que mientras dura ese despliegue el
código viejo no puede ingestar. Se despliega fuera de la hora del scraper.
Si aun así pasa, `/health` responde 503. Antes de cada push conviene pasar
`pnpm typecheck && pnpm test && pnpm validate:mobile`, que es lo que ningún
paso del build de Cloudflare comprueba.

### Desde cero (otra cuenta)

```bash
pnpm wrangler d1 create next-ride --location weur
```

Copia el `database_id` que devuelve en `d1_databases` de `wrangler.jsonc`.

```bash
pnpm wrangler r2 bucket create next-ride --location weur
```

```bash
pnpm wrangler secret put BETTER_AUTH_SECRET
```

```bash
pnpm db:migrate:remote
```

```bash
pnpm run deploy
```

### Traer los datos de la versión anterior

```bash
pnpm db:import-pg backups/nextride-XXXX.sql --owner tu@email.com
```

Genera `<volcado>.d1.sql` y `<volcado>.raw.json` junto al volcado. Entra en la
app al menos una vez con `--owner` (o deja que se siembre el superusuario) y:

```bash
pnpm wrangler d1 execute DB --remote --file backups/nextride-XXXX.d1.sql
```

```bash
pnpm wrangler r2 object put next-ride/raw/import/nextride-XXXX.raw.json --file backups/nextride-XXXX.raw.json --remote
```

Los usuarios no se importan (las contraseñas eran bcrypt): todo lo que era de
alguien —favoritos, seguimientos, quién descartó o editó, las API keys— pasa a
`--owner`, y todo entra en su cuenta. Las API keys se importan con su hash, así
que el skill no nota nada. Las fuentes y targets de rastreo del volcado
sustituyen a la semilla en la cuenta de `--owner`; las demás cuentas no se
tocan, y si alguna usa ya una fuente de la semilla, la importación falla entera.

---

## Cuentas y aislamiento

Cada fila del dominio es de una cuenta (`user_id`): ofertas con su historial,
dealers, versiones del catálogo, seguimientos, favoritos, runs del agente,
pesos de la puntuación, targets de rastreo y API keys. Ninguna consulta cruza de
una cuenta a otra:

- Lo que el scraper ingesta con una API key entra en la cuenta dueña de la clave,
  y `GET /scraping/config` le da solo los targets de esa cuenta. Una clave cuya
  cuenta está desactivada no entra.
- Una oferta, un dealer, una versión o un run de otra cuenta son un 404 en todos
  los verbos, igual que uno que no existe.
- Las métricas se calculan contra el mercado de la cuenta: la mediana del
  binomio es la de sus ofertas, no la de todas.
- La misma URL, el mismo dealer o la misma versión pueden estar en dos cuentas:
  son filas distintas, cada una con su estado, sus correcciones y su historial.

Lo único compartido son las fuentes (`scrape_sources`, los portales que sabe
leer el skill). Las ve cualquiera y solo las edita un superusuario: sus `notes`
y su `config` son instrucciones que sigue el scraper de todas las cuentas.

La API filtra por cuenta en cada consulta, y la base lo respalda con
disparadores: una oferta, su versión y su dealer son de la misma cuenta, y un
seguimiento, un favorito o un veredicto del agente no pueden señalar una fila
de otra (`migrations/0003_account_isolation.sql`). Lo que había antes de esa
migración era de una sola persona y pasó a la cuenta con superusuario más
antigua; en una base nueva, la semilla de rastreo es del superusuario de
`FIRST_SUPERUSER_EMAIL`.

---

## Estructura

```
worker/                  API (Hono) y todo lo que corre en Cloudflare
  index.ts               rutas, /health, cron de backups, export del Workflow
  auth.ts                Better Auth (PBKDF2 nativo, cookie de 30 días)
  bootstrap.ts           siembra perezosa: superusuario y API key del skill
  middleware.ts          requireUser (sesión) y requireIngest (sesión o X-API-Key)
  db/schema.ts           esquema de D1 (Drizzle)
  routes/                un fichero por recurso de /api/v1
  services/              métricas, puntuación, ingesta, agente, R2, backups
  workflows/ranking.ts   el agente de IA como Workflow durable
migrations/              SQL de D1 (drizzle-kit + semilla de rastreo)
src/                     la PWA (React + Vite)
public/                  manifest, service worker, iconos, splash, _headers
test/                    pruebas extremo a extremo (vitest-pool-workers)
scripts/                 auditoría PWA, presupuestos, splash, importación
next-ride/               el skill de captación (proyecto aparte, no se toca aquí)
```

---

## Decisiones del port

El port a Cloudflare conserva el comportamiento campo a campo; lo que cambia es
cómo se consigue. Lo que no es obvio:

- **Postgres → D1 (SQLite).** `percentile_cont`, `mode()` y los agregados de
  Analítica se calculan en TypeScript sobre las filas (`worker/lib/stats.ts`),
  con la misma interpolación lineal y el mismo desempate. Como `lower()` de
  SQLite solo pliega ASCII, la clave del binomio se **persiste** en
  `car_models.make_model_key` y se calcula en un único sitio.
- **Límites de D1**: 100 parámetros por sentencia y 1.000 sentencias por
  invocación (las de un `batch()` cuentan una a una). Los `IN (…)` van por
  `json_each(?)` con un solo parámetro, y la ingesta es por conjuntos: un lote
  de 1 o de 500 ofertas son nueve sentencias en dos `batch()` atómicos. La
  semántica del upsert —anclajes de `manual_fields`, historial solo si cambia el
  precio, una descartada no revive y una expirada sí— se decide en TypeScript
  con las filas existentes delante (`worker/services/offers.ts`). Si el lote
  falla al escribir, se reintenta oferta a oferta para aislar la mala.
- **Better Auth** sustituye al JWT propio. La sesión es una cookie HttpOnly del
  mismo origen, que es lo que mejor sobrevive en una PWA instalada en iOS
  (WebKit desaloja `localStorage` a los siete días sin visitas). Contraseñas
  con PBKDF2 de Web Crypto en vez del scrypt en JS por defecto, que se come la
  CPU de la invocación. El cliente de Better Auth se carga bajo demanda: solo lo
  descarga quien entra, sale o se registra.
- **El agente de IA es un Workflow.** Un run dura minutos, más de lo que
  aguanta un `waitUntil`. Cada vuelta del modelo es un paso durable: si el
  aislado muere, se rehidrata con las respuestas guardadas y sigue sin repetir
  llamadas. Las tools son puras sobre un contexto cargado en el primer paso,
  así que la conversación se reconstruye idéntica. Modelo por defecto
  `claude-opus-5-5`, esfuerzo `high` explícito (su defecto es `medium`) y
  fallbacks de servidor (`fallbacks: "default"`).
- **R2** guarda el payload crudo del scraper (un objeto por lote; la oferta solo
  apunta con `raw_ref`) y el backup diario: una tabla por objeto en NDJSON
  comprimido, legible con `zcat | jq`, con 30 días de retención. D1 trae además
  Time Travel para volver a cualquier minuto del último mes.
- **`/health`** compara la última migración aplicada con la última del
  repositorio, embebida en el build: 503 si el esquema está desfasado.
- **`user_id` admite NULL para SQLite** aunque Drizzle la declare obligatoria:
  se añadió con `ADD COLUMN`, porque reconstruir `offers` en D1 vaciaría por
  cascada su historial, sus favoritos y sus rankings (`defer_foreign_keys`
  aplaza comprobaciones, no acciones). Las altas sin cuenta las paran el tipo
  de Drizzle y los disparadores.
- **Desaparece**: Docker, nginx, compose, Makefile, Alembic y `/docs` (Swagger).

Diferencias aceptadas a sabiendas:

- La sesión se valida contra una caché firmada en cookie de 5 minutos: un
  usuario desactivado conserva el acceso hasta que caduca (antes, al instante).
- La búsqueda (`q`) solo iguala mayúsculas y minúsculas en ASCII, porque
  `lower()` y `LIKE` de SQLite no pliegan Unicode: «peña» no encuentra «PEÑA».
- Pensado para el plan Workers Paid (1.000 sentencias de D1 por invocación).
  En el gratuito (50), reemplazar muchos targets de rastreo de golpe o seguir
  un binomio con muchas versiones puede pasarse del tope.
- Si una persona descarta o corrige una oferta justo mientras el scraper ingesta
  un lote que la incluye, gana la persona: esa fila se salta y el scraper la
  actualiza en el siguiente pase.

---

## Métricas y puntuación

Se calculan **al leer**, no se persisten: siguen siendo correctas cuando entran
ofertas nuevas y la mediana se mueve. El mercado contra el que se mide una
oferta es su **binomio marca-modelo** (todas sus versiones), no su fila de
`car_models`: el catálogo está partido por acabado y la mediana de una versión
con una sola oferta sería el propio coche.

| Métrica | Cálculo |
|---|---|
| `discount_pct` | Descuento sobre el PVP anunciado por el dealer |
| `price_vs_median_pct` | Desviación respecto a la mediana del binomio |
| `price_vs_reference_pct` | Desviación respecto al PVP curado de la versión |
| `expected_price_eur` | Precio de nuevo depreciado por edad y ajustado por km |
| `price_vs_expected_pct` | Desviación respecto a ese valor esperado |
| `expected_price_source` | El ancla: `pvp` (curado) o `mercado` (curva invertida) |
| `price_drop_pct` | Bajada desde el primer precio visto |
| `km_per_year`, `days_listed` | Kilometraje anualizado, días desde que se vio |
| `value_score` | 0-100: media ponderada de las señales con dato |
| `score_breakdown` | El desglose auditable: `sum(points) == value_score` |

`value_score` (`worker/services/scoring.ts`) es la señal **determinista** de la
casa; la del agente de IA es independiente y se enseña aparte. Diez señales
(precio vs mercado, vs valor esperado, kilometraje, antigüedad, potencia en S,
cambio, dos notas manuales 1-5 ★, bajada de precio y frescura), cada una a un
subscore 0-100, y su media ponderada renormalizada sobre las que tienen dato.
Pesos y parámetros en `GET/PUT /api/v1/scoring/config` o en **Ajustes**.

---

## PWA para iPhone

- Instalable y arranca sin red (shell cacheado por `public/sw.js`); la API y la
  autenticación no se cachean nunca.
- Pantallas de arranque por tamaño de pantalla y tema para toda la gama desde
  el iPhone X hasta los Pro y Pro Max actuales (393, 402, 420, 430 y 440 pt),
  generadas desde el icono con `pnpm gen:splash`: sin ellas, una PWA instalada
  arranca en blanco.
- Áreas seguras y Dynamic Island vía `viewport-fit=cover` y `env(safe-area-*)`,
  barra de estado translúcida en standalone, barra de pestañas inferior.
- Presupuestos de peso (`perf-budgets.json`): 108 KB de arranque comprimido
  sobre 160 KB.

---

## Pendiente

- Alertas cuando una oferta baja del `target_price` de un modelo seguido (hoy
  se comprueba al leer; falta el disparador, que encaja en el cron).
- Ordenar por puntuación evalúa hasta 500 ofertas coincidentes; por encima de
  eso conviene materializar `value_score`.
- Los payloads crudos de lotes antiguos se quedan en R2 aunque la oferta apunte
  ya a uno más nuevo: una regla de ciclo de vida o una limpieza en el cron.
