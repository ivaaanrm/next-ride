/**
 * Esquema de D1.
 *
 * Las tablas del dominio conservan los nombres de columna del esquema de
 * Postgres anterior: así un volcado existente se importa columna a columna
 * (`scripts/pg-dump-to-d1.mjs`) y las respuestas de la API salen con las mismas
 * claves que ya consume el frontend.
 *
 * Diferencias con Postgres que hay que tener presentes:
 *
 * - Los importes son `REAL`, no `NUMERIC(12,2)`: se redondean a céntimos al
 *   escribir (`toCents`) y las comparaciones de precio se hacen redondeadas.
 * - Las fechas del dominio son texto ISO-8601 en UTC (`2026-10-07T08:00:00.000Z`):
 *   se ordenan bien como texto, que es como las compara SQLite, y se leen en la
 *   consola de D1. Las tablas de Better Auth usan sus enteros en milisegundos.
 * - Las columnas JSON son `TEXT`.
 * - `car_models.make_model_key` es nueva: la clave del binomio `marca|modelo`
 *   se persiste porque `lower()` de SQLite solo pliega ASCII y la clave no puede
 *   depender de quién la calcule (ver `services/catalog.ts`).
 * - El payload crudo del scraper ya no vive aquí: está en R2 y la oferta guarda
 *   solo la referencia (`raw_ref`).
 *
 * Aislamiento por cuenta: todo el dominio —ofertas, dealers, versiones,
 * rankings, captación, pesos de la puntuación y API keys— es de una cuenta
 * (`user_id`), y ninguna consulta cruza de una a otra. Lo único compartido son
 * los portales de `scrape_sources`, que mantiene un superusuario. Ver
 * `migrations/0003_account_isolation.sql`.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** Igual que `new Date().toISOString()`, pero calculado por SQLite. */
const NOW_ISO = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const nowIso = () => new Date().toISOString();

const timestamps = {
  created_at: text("created_at").notNull().default(NOW_ISO),
  updated_at: text("updated_at")
    .notNull()
    .default(NOW_ISO)
    .$onUpdateFn(() => nowIso()),
};

const bool = (name: string) => integer(name, { mode: "boolean" });

/**
 * La cuenta dueña de la fila. Obligatoria para el tipo y para los disparadores
 * de la migración 0003, aunque la columna de SQLite admita NULL: se añadió con
 * `ADD COLUMN` porque reconstruir `offers` en D1 vaciaría por cascada su
 * historial, sus favoritos y sus rankings.
 */
const ownerId = () =>
  text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" });

// --------------------------------------------------------------------------- //
// Enumeraciones (TEXT + CHECK, como el `native_enum=False` de antes)
// --------------------------------------------------------------------------- //
export const OFFER_STATUS = ["active", "dismissed", "expired"] as const;
export const VEHICLE_CONDITION = ["new", "km0", "used", "demo"] as const;
export const FUEL_TYPE = [
  "petrol",
  "diesel",
  "hybrid",
  "plugin_hybrid",
  "electric",
  "lpg",
  "other",
] as const;
export const TRANSMISSION = ["manual", "automatic", "other"] as const;
export const RUN_STATUS = ["pending", "running", "completed", "failed"] as const;
export const VERDICT = ["excellent", "good", "fair", "poor", "avoid"] as const;
export const SCRAPE_ACCESS = ["fetch", "playwright", "browser", "manual"] as const;

export type OfferStatus = (typeof OFFER_STATUS)[number];
export type VehicleCondition = (typeof VEHICLE_CONDITION)[number];
export type FuelType = (typeof FUEL_TYPE)[number];
export type Transmission = (typeof TRANSMISSION)[number];
export type RunStatus = (typeof RUN_STATUS)[number];
export type Verdict = (typeof VERDICT)[number];
export type ScrapeAccess = (typeof SCRAPE_ACCESS)[number];

const inList = (column: string, values: readonly string[]) =>
  sql.raw(`${column} IN (${values.map((value) => `'${value}'`).join(", ")})`);

// --------------------------------------------------------------------------- //
// Better Auth
//
// Las claves del objeto (`emailVerified`, `userId`…) son las que espera el
// adaptador de Drizzle; los nombres de columna van en snake_case como el resto.
// --------------------------------------------------------------------------- //
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull().default(""),
  email: text("email").notNull().unique(),
  emailVerified: bool("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  // Campos propios (`user.additionalFields` en `auth.ts`).
  isActive: bool("is_active").notNull().default(true),
  isSuperuser: bool("is_superuser").notNull().default(false),
  lastLoginAt: integer("last_login_at", { mode: "timestamp_ms" }),
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [index("ix_sessions_user_id").on(table.userId)],
);

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("ix_accounts_user_id").on(table.userId)],
);

export const verifications = sqliteTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("ix_verifications_identifier").on(table.identifier)],
);

// --------------------------------------------------------------------------- //
// API keys (servicio scraper)
//
// Propias y no el plugin de Better Auth: el skill ya tiene claves con formato
// `nr_<prefijo>_<secreto>` y hash SHA-256, y tienen que seguir valiendo.
//
// Una clave es de una cuenta, y lo que el scraper ingesta con ella entra en esa
// cuenta y en ninguna otra.
// --------------------------------------------------------------------------- //
export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    user_id: ownerId(),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    hashed_key: text("hashed_key").notNull().unique(),
    is_active: bool("is_active").notNull().default(true),
    last_used_at: text("last_used_at"),
    created_by_id: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (table) => [index("ix_api_keys_prefix").on(table.prefix), index("ix_api_keys_user").on(table.user_id)],
);

// --------------------------------------------------------------------------- //
// Invitaciones
//
// Con el registro cerrado, la única puerta de entrada: un superusuario invita a
// un email y le llega un enlace de un solo uso. Del token solo se guarda el
// hash, como de las API keys: quien lea la base no puede aceptar por nadie.
// --------------------------------------------------------------------------- //
export const invitations = sqliteTable(
  "invitations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    email: text("email").notNull(),
    token_hash: text("token_hash").notNull().unique(),
    invited_by_id: text("invited_by_id").references(() => users.id, { onDelete: "set null" }),
    expires_at: text("expires_at").notNull(),
    accepted_at: text("accepted_at"),
    accepted_user_id: text("accepted_user_id").references(() => users.id, { onDelete: "set null" }),
    revoked_at: text("revoked_at"),
    email_sent_at: text("email_sent_at"),
    ...timestamps,
  },
  (table) => [index("ix_invitations_email").on(table.email)],
);

// --------------------------------------------------------------------------- //
// Catálogo
// --------------------------------------------------------------------------- //
export const dealers = sqliteTable(
  "dealers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    user_id: ownerId(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    website: text("website"),
    city: text("city"),
    country: text("country"),
    // Reputación del dealer (0-5), informada por el scraper o a mano.
    rating: real("rating"),
    is_active: bool("is_active").notNull().default(true),
    notes: text("notes"),
    ...timestamps,
  },
  (table) => [uniqueIndex("uq_dealers_user_slug").on(table.user_id, table.slug)],
);

/** Un modelo concreto (marca + modelo, opcionalmente acabado). */
export const carModels = sqliteTable(
  "car_models",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    user_id: ownerId(),
    slug: text("slug").notNull(),
    make: text("make").notNull(),
    model: text("model").notNull(),
    trim: text("trim").notNull().default(""),
    // `marca|modelo` en minúsculas: el binomio con el que se compara un mercado.
    make_model_key: text("make_model_key").notNull(),
    body_type: text("body_type"),
    // Precio de referencia de mercado / PVP, ancla del descuento y del valor esperado.
    reference_price: real("reference_price"),
    is_active: bool("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("uq_car_models_user_slug").on(table.user_id, table.slug),
    uniqueIndex("uq_car_model_identity").on(table.user_id, table.make, table.model, table.trim),
    index("ix_car_models_user_key").on(table.user_id, table.make_model_key),
  ],
);

/** Modelo que un usuario decide seguir en la plataforma. */
export const trackedModels = sqliteTable(
  "tracked_models",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    car_model_id: integer("car_model_id")
      .notNull()
      .references(() => carModels.id, { onDelete: "cascade" }),
    target_price: real("target_price"),
    max_mileage_km: integer("max_mileage_km"),
    min_year: integer("min_year"),
    is_active: bool("is_active").notNull().default(true),
    notes: text("notes"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("uq_tracked_model").on(table.user_id, table.car_model_id),
    index("ix_tracked_models_car_model_id").on(table.car_model_id),
  ],
);

// --------------------------------------------------------------------------- //
// Ofertas
// --------------------------------------------------------------------------- //
export const offers = sqliteTable(
  "offers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    user_id: ownerId(),
    // Identidad en el origen. `url` es la clave natural del upsert, dentro de
    // cada cuenta: dos cuentas que rastrean el mismo anuncio tienen dos ofertas.
    url: text("url").notNull(),
    external_id: text("external_id"),
    source: text("source"),
    dealer_id: integer("dealer_id")
      .notNull()
      .references(() => dealers.id, { onDelete: "restrict" }),
    car_model_id: integer("car_model_id")
      .notNull()
      .references(() => carModels.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    price: real("price").notNull(),
    // PVP / precio antes de descuento anunciado por el dealer.
    original_price: real("original_price"),
    currency: text("currency").notNull().default("EUR"),
    year: integer("year"),
    mileage_km: integer("mileage_km"),
    power_hp: integer("power_hp"),
    condition: text("condition", { enum: VEHICLE_CONDITION }).notNull().default("used"),
    fuel_type: text("fuel_type", { enum: FUEL_TYPE }),
    transmission: text("transmission", { enum: TRANSMISSION }),
    location: text("location"),
    image_url: text("image_url"),
    status: text("status", { enum: OFFER_STATUS }).notNull().default("active"),
    dismissed_at: text("dismissed_at"),
    dismissed_by_id: text("dismissed_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    dismiss_reason: text("dismiss_reason"),
    first_seen_at: text("first_seen_at").notNull().default(NOW_ISO),
    last_seen_at: text("last_seen_at").notNull().default(NOW_ISO),
    // Columnas corregidas a mano: el scraper ya no las escribe (ver la ingesta).
    // Es de la oferta y no del usuario: la corrección afirma algo del coche.
    manual_fields: text("manual_fields", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    edited_at: text("edited_at"),
    edited_by_id: text("edited_by_id").references(() => users.id, { onDelete: "set null" }),
    // Valoración manual 1-5, o NULL mientras nadie la haya puesto. NULL no es
    // un cero: sin nota la señal no puntúa y su peso se reparte entre las demás.
    equipment_rating: integer("equipment_rating"),
    apparent_condition_rating: integer("apparent_condition_rating"),
    // Dónde está en R2 el payload crudo del scraper: `<clave del objeto>#<índice>`.
    raw_ref: text("raw_ref"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("uq_offers_user_url").on(table.user_id, table.url),
    // Los índices que empiezan por una clave llevan la cuenta justo detrás.
    // Sin estadísticas, SQLite elige el índice que casa más columnas por
    // igualdad: `user_id = ? AND status = ? AND dealer_id = ?` empataba entre
    // (user_id, status) y (dealer_id, status) y se quedaba con el de la cuenta,
    // que recorre todas sus ofertas para sacar las de un dealer. Con la cuenta
    // dentro, el de la clave casa tres y gana siempre; y sigue empezando por la
    // clave, que es lo que piden las uniones y las claves ajenas.
    index("ix_offers_model_user_status_price").on(
      table.car_model_id,
      table.user_id,
      table.status,
      table.price,
    ),
    index("ix_offers_dealer_user_status_price").on(
      table.dealer_id,
      table.user_id,
      table.status,
      table.price,
    ),
    index("ix_offers_user_status_last_seen").on(table.user_id, table.status, table.last_seen_at),
    // Las candidatas del orden por puntuación y el orden por precio: las N más
    // baratas de la cuenta salen en orden del índice, sin leer las demás.
    index("ix_offers_user_status_price").on(table.user_id, table.status, table.price),
    index("ix_offers_external_id").on(table.external_id),
    check("ck_offers_status", inList("status", OFFER_STATUS)),
    check("ck_offers_condition", inList("condition", VEHICLE_CONDITION)),
    check("ck_offers_fuel_type", sql`fuel_type IS NULL OR ${inList("fuel_type", FUEL_TYPE)}`),
    check(
      "ck_offers_transmission",
      sql`transmission IS NULL OR ${inList("transmission", TRANSMISSION)}`,
    ),
    check(
      "ck_offers_ratings",
      sql`(equipment_rating IS NULL OR equipment_rating BETWEEN 1 AND 5) AND (apparent_condition_rating IS NULL OR apparent_condition_rating BETWEEN 1 AND 5)`,
    ),
  ],
);

/** Se anota un registro cada vez que el scraper reporta un precio distinto. */
export const offerPriceHistory = sqliteTable(
  "offer_price_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    offer_id: integer("offer_id")
      .notNull()
      .references(() => offers.id, { onDelete: "cascade" }),
    price: real("price").notNull(),
    recorded_at: text("recorded_at").notNull().default(NOW_ISO),
  },
  (table) => [index("ix_offer_price_history_offer").on(table.offer_id, table.recorded_at)],
);

/**
 * Oferta marcada por un usuario concreto. Es una marca *personal*, no un estado
 * de la oferta: por eso vive en su propia tabla y no como columna de `offers`.
 */
export const offerFavorites = sqliteTable(
  "offer_favorites",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    offer_id: integer("offer_id")
      .notNull()
      .references(() => offers.id, { onDelete: "cascade" }),
    created_at: text("created_at").notNull().default(NOW_ISO),
  },
  (table) => [
    uniqueIndex("uq_offer_favorite").on(table.user_id, table.offer_id),
    index("ix_offer_favorites_offer").on(table.offer_id),
  ],
);

// --------------------------------------------------------------------------- //
// Ranking con IA
// --------------------------------------------------------------------------- //
/**
 * Una ejecución del agente sobre las ofertas de un binomio marca-modelo. El
 * objetivo es el binomio y no la fila de `car_models`: el catálogo está partido
 * por acabado, y rankear una versión era rankear una oferta contra sí misma.
 */
export const rankingRuns = sqliteTable(
  "ranking_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // Un run rankea las ofertas de su cuenta, y solo esa cuenta lo ve.
    user_id: ownerId(),
    make_model_key: text("make_model_key").notNull(),
    // La grafía con la que se enseñó («Audi A3»), congelada al lanzar el run.
    label: text("label").notNull().default(""),
    status: text("status", { enum: RUN_STATUS }).notNull().default("pending"),
    triggered_by_id: text("triggered_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    model_used: text("model_used"),
    effort: text("effort"),
    offers_considered: integer("offers_considered").notNull().default(0),
    iterations: integer("iterations").notNull().default(0),
    input_tokens: integer("input_tokens").notNull().default(0),
    output_tokens: integer("output_tokens").notNull().default(0),
    summary: text("summary"),
    error: text("error"),
    // Traza de tools usadas: [{"tool": "...", "input": {...}}]
    tool_trace: text("tool_trace", { mode: "json" }).$type<Record<string, unknown>[]>(),
    // Los parámetros con los que se lanzó (presupuesto, km, año, prioridades).
    request: text("request", { mode: "json" }).$type<Record<string, unknown>>(),
    created_at: text("created_at").notNull().default(NOW_ISO),
    finished_at: text("finished_at"),
  },
  (table) => [
    index("ix_ranking_runs_user_binomio_created").on(
      table.user_id,
      table.make_model_key,
      table.created_at,
    ),
    check("ck_ranking_runs_status", inList("status", RUN_STATUS)),
  ],
);

/** Veredicto del agente para una oferta concreta dentro de un run. */
export const offerRankings = sqliteTable(
  "offer_rankings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    run_id: integer("run_id")
      .notNull()
      .references(() => rankingRuns.id, { onDelete: "cascade" }),
    offer_id: integer("offer_id")
      .notNull()
      .references(() => offers.id, { onDelete: "cascade" }),
    rank: integer("rank").notNull(),
    score: integer("score").notNull(),
    verdict: text("verdict", { enum: VERDICT }).notNull(),
    reasoning: text("reasoning"),
    pros: text("pros", { mode: "json" }).$type<string[]>(),
    cons: text("cons", { mode: "json" }).$type<string[]>(),
  },
  (table) => [
    index("ix_offer_rankings_run_rank").on(table.run_id, table.rank),
    index("ix_offer_rankings_offer").on(table.offer_id),
    check("ck_offer_rankings_verdict", inList("verdict", VERDICT)),
  ],
);

// --------------------------------------------------------------------------- //
// Configuración
// --------------------------------------------------------------------------- //
/**
 * Pesos y parámetros de la puntuación de valor: una fila por cuenta. Van en
 * JSON porque su esquema es el de `schemas/scoring.ts`, que ya valida en el
 * borde de la API. La fila puede no existir: rigen los defaults.
 */
export const scoreConfig = sqliteTable(
  "score_config",
  {
    id: integer("id").primaryKey(),
    user_id: ownerId(),
    weights: text("weights", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    params: text("params", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("uq_score_config_user").on(table.user_id)],
);

/**
 * Portal o dealer desde el que el scraper obtiene inventario. No es `dealers`:
 * una fuente puede contener anuncios de muchos vendedores.
 *
 * Es lo único compartido entre cuentas —qué portales sabe leer el skill— y por
 * eso solo lo edita un superusuario: sus `notes` y su `config` son instrucciones
 * que sigue el scraper de cada cuenta.
 */
export const scrapeSources = sqliteTable(
  "scrape_sources",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    key: text("key").notNull().unique(),
    name: text("name").notNull(),
    base_url: text("base_url").notNull(),
    search_url_template: text("search_url_template"),
    listing_url: text("listing_url"),
    access: text("access", { enum: SCRAPE_ACCESS }).notNull(),
    notes: text("notes"),
    config: text("config", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
    is_active: bool("is_active").notNull().default(true),
    ...timestamps,
  },
  () => [check("ck_scrape_sources_access", inList("access", SCRAPE_ACCESS))],
);

/** Una combinación concreta de binomio marca-modelo y fuente, de una cuenta. */
export const scrapeTargets = sqliteTable(
  "scrape_targets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    user_id: ownerId(),
    source_id: integer("source_id")
      .notNull()
      .references(() => scrapeSources.id, { onDelete: "cascade" }),
    make_model_key: text("make_model_key").notNull(),
    make: text("make").notNull(),
    model: text("model").notNull(),
    max_results: integer("max_results").notNull().default(15),
    // Si la URL no sale de la plantilla de la fuente, el skill la descubre y la
    // persiste aquí. Los ids/slugs propios del portal viven en `search_params`.
    search_url: text("search_url"),
    search_params: text("search_params", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
    is_active: bool("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("uq_scrape_target_source_model").on(
      table.user_id,
      table.source_id,
      table.make_model_key,
    ),
    index("ix_scrape_targets_user_active").on(table.user_id, table.is_active),
  ],
);

export const schema = {
  users,
  sessions,
  accounts,
  verifications,
  apiKeys,
  invitations,
  dealers,
  carModels,
  trackedModels,
  offers,
  offerPriceHistory,
  offerFavorites,
  rankingRuns,
  offerRankings,
  scoreConfig,
  scrapeSources,
  scrapeTargets,
};

export type Dealer = typeof dealers.$inferSelect;
export type CarModel = typeof carModels.$inferSelect;
export type TrackedModel = typeof trackedModels.$inferSelect;
export type Offer = typeof offers.$inferSelect;
export type RankingRun = typeof rankingRuns.$inferSelect;
export type OfferRanking = typeof offerRankings.$inferSelect;
export type ScrapeSource = typeof scrapeSources.$inferSelect;
export type ScrapeTarget = typeof scrapeTargets.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Invitation = typeof invitations.$inferSelect;
export type User = typeof users.$inferSelect;
