# Port a Cloudflare (Workers + D1 + R2) con Better Auth

Rama: `cloudflare/port`. El directorio `next-ride/` (el skill de captación) **no se toca**:
su contrato con la API se conserva tal cual.

## Contrato que no se puede romper

El skill habla con la API con `X-API-Key: nr_<prefijo>_<secreto>` contra:

- `GET  /api/v1/scraping/config`
- `PATCH /api/v1/scraping/targets/{id}`
- `POST /api/v1/offers/bulk` (lotes de 25)

Mismas rutas, mismos cuerpos, mismo formato de clave y **mismo hash** (SHA-256 hex), para
que la `NR_API_KEY` que ya tiene el skill siga valiendo (se registra con
`BOOTSTRAP_SCRAPER_API_KEY`). El frontend consume el resto de `/api/v1/*` con las formas de
respuesta de los esquemas Pydantic; se replican campo a campo.

## Arquitectura

Un único Worker sirve la SPA (Workers Static Assets, modo SPA) y la API (Hono) desde el
mismo origen: sin CORS y con cookies de sesión de primera parte, que es lo que mejor
sobrevive en una PWA instalada en iOS.

| Antes | Después |
|-------|---------|
| FastAPI + SQLAlchemy | Hono + Drizzle ORM (TypeScript) |
| Postgres 17 + Alembic | D1 (SQLite) + migraciones SQL de drizzle-kit |
| JWT propio (access/refresh en localStorage) | Better Auth: email+contraseña, sesión en cookie HttpOnly |
| `BackgroundTasks` para el agente | Cloudflare Workflows (`RankingWorkflow`), un paso por llamada al modelo |
| `raw` en una columna JSON | R2: un objeto por lote de ingesta, referenciado desde la oferta |
| `backups/` con pg_dump a mano | Cron diario: volcado NDJSON.gz de las tablas a R2 (30 días) |
| nginx + Docker + compose + Makefile | `wrangler.jsonc` + `@cloudflare/vite-plugin` + scripts de pnpm |
| Deploy por SSH | GitHub Actions con `wrangler deploy` |

### Decisiones con letra pequeña

- **Postgres → SQLite.** `percentile_cont`, `mode()` y los agregados de Analítica se calculan
  en TypeScript sobre las filas (interpolación lineal idéntica a `percentile_cont`; empate de
  `mode()` resuelto por orden, como Postgres). `lower()` de SQLite solo pliega ASCII, así que
  la clave del binomio se **persiste** en `car_models.make_model_key`, calculada en un solo
  sitio (TS).
- **Límites de D1**: 100 parámetros por sentencia y 1.000 sentencias por invocación (cada
  sentencia de un `batch()` cuenta). Los `IN (...)` van por `json_each(?)` con un único
  parámetro, y la ingesta es por conjuntos (`INSERT … SELECT FROM json_each(?)`): ~10
  sentencias por lote, sea de 1 o de 500 ofertas. El anclaje de `manual_fields` se resuelve
  en SQL con la misma semántica que `upsert_offer`.
- **Sin transacciones interactivas** en D1: lo que debe ser atómico va en `db.batch()`.
- **API keys** siguen siendo propias (no el plugin de Better Auth) para conservar formato y
  hash de las claves que ya existen.
- **Contraseñas**: PBKDF2-SHA256 de Web Crypto (nativo en workerd, 100k iteraciones) en vez
  del scrypt en JS por defecto, que se come el presupuesto de CPU del Worker.
- **Superusuario**: se siembra perezosamente en la primera petición si existen
  `FIRST_SUPERUSER_EMAIL` / `FIRST_SUPERUSER_PASSWORD`, igual que hacía `init_db`. El registro
  abierto se controla con `ALLOW_REGISTRATION`.
- **Fuentes y targets de rastreo por defecto**: migración SQL de semilla (antes, en el
  arranque).
- **`/health`** compara la última migración aplicada (`d1_migrations`) con la última del
  repositorio, embebida en el build: 503 si el esquema está desfasado.
- **`/docs` (Swagger)** desaparece.

## Fases

1. **Andamiaje**: proyecto único en la raíz (Vite 8 + plugin de Cloudflare), `src/` (SPA),
   `worker/` (API), `migrations/`, `wrangler.jsonc`, tipos generados.
2. **Esquema**: Drizzle (dominio + tablas de Better Auth), migración inicial y semilla.
3. **Servicios**: catálogo, puntuación, métricas, ofertas (ingesta por conjuntos),
   configuración de scraping.
4. **Rutas**: auth (`/auth/me`, config), api-keys, dealers, car-models, tracked-models,
   scraping, scoring, offers, rankings, stats, analytics, health.
5. **Agente de IA** como Workflow.
6. **R2**: `raw` por lote y backups programados.
7. **Frontend**: cliente de Better Auth (cookies, sin tokens), login/registro, ajustes de
   service worker y cabeceras (`public/_headers`).
8. **PWA para iPhone Pro actual**: splash screens por tamaño de dispositivo (claro/oscuro),
   revisión de áreas seguras / Dynamic Island, manifest.
9. **Limpieza**: fuera `backend/`, Docker, nginx, compose, Makefile, Alembic, ruff, deploy
   por SSH. README nuevo.
10. **Verificación**: tests extremo a extremo contra el Worker real (D1 local), build,
    presupuestos PWA, prueba en navegador a tamaño iPhone.
11. **Datos**: script para pasar un `pg_dump` existente a SQL de D1.
