/**
 * Ofertas: lectura con métricas, ingesta, corrección manual, estado y favoritos.
 *
 * Cada cuenta ve y toca solo las suyas. Una oferta de otra cuenta es un 404 en
 * todos los verbos, igual que una que no existe: ni siquiera se confirma que
 * esté.
 */
import { and, asc, count, countDistinct, desc, eq, max, min, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { router, type AppEnv } from "../app";
import {
  carModels,
  dealers,
  FUEL_TYPE,
  nowIso,
  OFFER_STATUS,
  offerFavorites,
  offerPriceHistory,
  offers,
  VEHICLE_CONDITION,
  type OfferStatus,
} from "../db/schema";
import { roundOrNull, type Db } from "../lib/db";
import {
  notFound,
  PageQuery,
  parseBody,
  parseId,
  parseQuery,
  qBool,
  qInt,
  qNumber,
  qString,
} from "../lib/http";
import { owned, ownedRow } from "../lib/tenant";
import { requireIngest, requireUser } from "../middleware";
import {
  OfferBulkIngest,
  OfferDismiss,
  OfferIngest,
  OfferRatingUpdate,
  OfferUpdate,
} from "../schemas/offer";
import { enrichOffers, type OfferWithRelations } from "../services/metrics";
import { applyManualEdit, ingestOffers } from "../services/offers";
import { getRaw } from "../services/raw-store";
import {
  latestAiSummaries,
  loadOffer,
  loadOffers,
  modelDisplayName,
  serializeOffers,
  type OfferRankSummary,
} from "../services/serialize";
import type { Context } from "hono";

// --------------------------------------------------------------------------- //
// Filtros compartidos
//
// Están aquí y no repetidos en cada endpoint para que `GET /offers`,
// `GET /offers/stats` y `/analytics/segments` no puedan divergir: si
// divergieran, las métricas describirían un conjunto distinto del de la tabla.
// --------------------------------------------------------------------------- //
export const OfferFilters = z.object({
  status: z.enum(OFFER_STATUS).optional(),
  car_model_id: qInt(),
  dealer_id: qInt(),
  condition: z.enum(VEHICLE_CONDITION).optional(),
  fuel_type: z.enum(FUEL_TYPE).optional(),
  min_price: qNumber(z.number().min(0)),
  max_price: qNumber(z.number().min(0)),
  max_mileage_km: qInt(z.number().min(0)),
  min_year: qInt(z.number().min(1950)),
  max_year: qInt(z.number().min(1950)),
  q: qString,
  tracked_only: qBool,
  favorites_only: qBool,
});
export type OfferFilters = z.output<typeof OfferFilters>;

/** Las condiciones del filtro, siempre dentro de las ofertas de la cuenta `tenantId`. */
export function filterConditions(filters: OfferFilters, tenantId: string): SQL {
  const conditions: (SQL | undefined)[] = [
    owned(offers, tenantId),
    eq(offers.status, filters.status ?? "active"),
  ];
  if (filters.car_model_id) conditions.push(eq(offers.car_model_id, filters.car_model_id));
  if (filters.dealer_id) conditions.push(eq(offers.dealer_id, filters.dealer_id));
  if (filters.condition) conditions.push(eq(offers.condition, filters.condition));
  if (filters.fuel_type) conditions.push(eq(offers.fuel_type, filters.fuel_type));
  if (filters.min_price !== undefined) conditions.push(sql`${offers.price} >= ${filters.min_price}`);
  if (filters.max_price !== undefined) conditions.push(sql`${offers.price} <= ${filters.max_price}`);
  if (filters.max_mileage_km !== undefined) {
    conditions.push(sql`${offers.mileage_km} <= ${filters.max_mileage_km}`);
  }
  if (filters.min_year !== undefined) conditions.push(sql`${offers.year} >= ${filters.min_year}`);
  if (filters.max_year !== undefined) conditions.push(sql`${offers.year} <= ${filters.max_year}`);
  if (filters.q) {
    conditions.push(sql`lower(${offers.title}) LIKE ${`%${filters.q.toLowerCase()}%`}`);
  }
  if (filters.tracked_only) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM tracked_models t WHERE t.car_model_id = ${offers.car_model_id} AND t.user_id = ${tenantId} AND t.is_active = 1)`,
    );
  }
  if (filters.favorites_only) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM offer_favorites f WHERE f.offer_id = ${offers.id} AND f.user_id = ${tenantId})`,
    );
  }
  return and(...conditions)!;
}

/** Mismo cálculo que `computeMetrics`: km entre la edad, con un año de suelo. */
export const kmPerYearSql = () =>
  sql<number | null>`CASE WHEN ${offers.mileage_km} IS NOT NULL AND ${offers.year} IS NOT NULL
    THEN CAST(${offers.mileage_km} AS REAL) / MAX(CAST(${new Date().getUTCFullYear()} - ${offers.year} AS REAL), 1.0)
  END`;

export const discountSql = () =>
  sql<number | null>`CASE WHEN ${offers.original_price} > 0
    THEN (${offers.original_price} - ${offers.price}) / ${offers.original_price} * 100
  END`;

// --------------------------------------------------------------------------- //
// Orden
// --------------------------------------------------------------------------- //
const SORTS = [
  "price",
  "-price",
  "year",
  "-year",
  "mileage_km",
  "-mileage_km",
  "first_seen_at",
  "-first_seen_at",
  "-last_seen_at",
  "value_score",
  "ai_score",
] as const;

// `NULLS LAST` en los dos sentidos: un año que el scraper no trajo no es «el
// más antiguo», así que no debe encabezar el orden ascendente.
const DB_SORTS: Partial<Record<(typeof SORTS)[number], SQL>> = {
  price: asc(offers.price),
  "-price": desc(offers.price),
  year: sql`${offers.year} ASC NULLS LAST`,
  "-year": sql`${offers.year} DESC NULLS LAST`,
  mileage_km: sql`${offers.mileage_km} ASC NULLS LAST`,
  "-mileage_km": sql`${offers.mileage_km} DESC NULLS LAST`,
  first_seen_at: asc(offers.first_seen_at),
  "-first_seen_at": desc(offers.first_seen_at),
  "-last_seen_at": desc(offers.last_seen_at),
};

/**
 * Ordenar por puntuación exige calcular métricas en TypeScript, así que se acota
 * cuántas filas se traen antes de ordenar y paginar.
 */
export const SCORE_SORT_CAP = 500;

/**
 * Las candidatas del orden por puntuación, con sus métricas: las
 * `SCORE_SORT_CAP` más baratas del filtro. `ix_offers_user_status_price` las da
 * ya en ese orden, así que se leen esas filas y no todas las de la cuenta para
 * ordenarlas antes. El listado y el mejor chollo de `/stats` comparten esto, y
 * así coinciden en la fila de arriba.
 */
async function scoredCandidates(db: Db, tenantId: string, where: SQL) {
  const list = await loadOffers(db, tenantId, {
    where,
    orderBy: [asc(offers.price), asc(offers.id)],
    limit: SCORE_SORT_CAP,
  });
  return { list, metrics: await enrichOffers(db, tenantId, list) };
}

const ListQuery = OfferFilters.extend({
  sort: z.enum(SORTS).default("value_score"),
  ...PageQuery.shape,
});

/** La primera oferta con la puntuación más alta (como `max()` de Python). */
export function bestByScore<T extends { id: number }>(
  list: T[],
  scoreOf: (item: T) => number | null,
): T | null {
  let best: T | null = null;
  let bestScore = -Infinity;
  for (const item of list) {
    const score = scoreOf(item) ?? 0;
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

async function getOfferOr404(db: Db, tenantId: string, id: number): Promise<OfferWithRelations> {
  const offer = await loadOffer(db, tenantId, id);
  if (!offer) throw notFound("Oferta no encontrada");
  return offer;
}

async function respondOne(c: Context<AppEnv>, id: number) {
  const offer = await getOfferOr404(c.var.db, c.var.tenantId, id);
  return (await serializeOffers(c.var.db, c.var.tenantId, [offer]))[0];
}

export const offersRoutes = router();

// ---- Ingesta: la consume el skill (sesión o X-API-Key) ----------------------- //
// Entra en la cuenta de quien ingesta: la de la sesión o la dueña de la clave.
offersRoutes.post("/", requireIngest, async (c) => {
  // El cuerpo se valida entero antes de tocar nada: aquí un error es un 422.
  const payload = await parseBody(c, OfferIngest);
  const result = await ingestOffers(c.env.DB, c.env.BUCKET, c.var.tenantId, [payload]);
  if (!result.offer_ids.length) throw new Error(result.errors[0] ?? "No se pudo guardar la oferta");
  return c.json(await respondOne(c, result.offer_ids[0]), 201);
});

offersRoutes.post("/bulk", requireIngest, async (c) => {
  const payload = await parseBody(c, OfferBulkIngest);
  return c.json(
    await ingestOffers(c.env.DB, c.env.BUCKET, c.var.tenantId, payload.offers),
  );
});

// ---- Lectura ------------------------------------------------------------------ //
offersRoutes.get("/", requireUser, async (c) => {
  const { sort, limit, offset, ...filters } = parseQuery(c, ListQuery);
  const db = c.var.db;
  const tenantId = c.var.tenantId;
  const where = filterConditions(filters, tenantId);
  const counted = db.select({ total: count() }).from(offers).where(where);

  const dbSort = DB_SORTS[sort];
  if (dbSort) {
    const [[{ total }], list] = await Promise.all([
      counted,
      loadOffers(db, tenantId, { where, orderBy: [dbSort, asc(offers.id)], limit, offset }),
    ]);
    return c.json({ items: await serializeOffers(db, tenantId, list), total, limit, offset });
  }

  // Ordenación por puntuación: se puntúan las candidatas, se ordenan y solo la
  // página se serializa (veredictos y favoritos de 50 ofertas, no de 500).
  const [[{ total }], { list, metrics }] = await Promise.all([
    counted,
    scoredCandidates(db, tenantId, where),
  ]);
  const valueOf = (offer: OfferWithRelations) => metrics.get(offer.id)!.value_score ?? 0;
  const ordered = [...list];
  let ai: Map<number, OfferRankSummary> | undefined;
  if (sort === "ai_score") {
    const ranks = (ai = await latestAiSummaries(db, tenantId, list));
    ordered.sort(
      (a, b) =>
        Number(!ranks.has(a.id)) - Number(!ranks.has(b.id)) ||
        (ranks.get(b.id)?.score ?? 0) - (ranks.get(a.id)?.score ?? 0) ||
        valueOf(b) - valueOf(a),
    );
  } else {
    ordered.sort((a, b) => valueOf(b) - valueOf(a));
  }
  const page = ordered.slice(offset, offset + limit);
  return c.json({
    items: await serializeOffers(db, tenantId, page, { metrics, ai }),
    total: Math.min(total, SCORE_SORT_CAP),
    limit,
    offset,
  });
});

/** Agregados sobre las filas que cumplen el filtro, no sobre todo el catálogo. */
offersRoutes.get("/stats", requireUser, async (c) => {
  const filters = parseQuery(c, OfferFilters);
  const db = c.var.db;
  const tenantId = c.var.tenantId;

  // Extremos para los controles de rango, cada uno con **su propio filtro
  // quitado**: son el dominio del deslizador, no un agregado de lo que se ve.
  // Con el filtro puesto, el carril se encogería a la selección en cada arrastre.
  const [[row], [priceRange], [yearRange], candidates] = await Promise.all([
    db
      .select({
        count: count(),
        car_models: countDistinct(offers.car_model_id),
        avg_price: sql<number | null>`AVG(${offers.price})`,
        avg_mileage_km: sql<number | null>`AVG(${offers.mileage_km})`,
        avg_km_per_year: sql<number | null>`AVG(${kmPerYearSql()})`,
        avg_discount_pct: sql<number | null>`AVG(${discountSql()})`,
      })
      .from(offers)
      .where(filterConditions(filters, tenantId)),
    db
      .select({ floor: min(offers.price), ceiling: max(offers.price) })
      .from(offers)
      .where(
        filterConditions({ ...filters, min_price: undefined, max_price: undefined }, tenantId),
      ),
    db
      .select({ floor: min(offers.year), ceiling: max(offers.year) })
      .from(offers)
      .where(filterConditions({ ...filters, min_year: undefined, max_year: undefined }, tenantId)),
    // El mejor chollo exige puntuar en TS: son las mismas candidatas que las
    // del orden por puntuación del listado, así ambos coinciden en la de arriba.
    scoredCandidates(db, tenantId, filterConditions(filters, tenantId)),
  ]);

  const { metrics } = candidates;
  const top = bestByScore(candidates.list, (offer) => metrics.get(offer.id)!.value_score);
  const bestDeal = top ? (await serializeOffers(db, tenantId, [top], { metrics }))[0] : null;

  return c.json({
    count: row.count,
    car_models: row.car_models,
    avg_price: roundOrNull(row.avg_price),
    avg_mileage_km: roundOrNull(row.avg_mileage_km, 0),
    avg_km_per_year: roundOrNull(row.avg_km_per_year, 0),
    avg_discount_pct: roundOrNull(row.avg_discount_pct),
    best_deal: bestDeal,
    ai_enabled: Boolean(c.env.ANTHROPIC_API_KEY),
    price_floor: roundOrNull(priceRange.floor),
    price_ceiling: roundOrNull(priceRange.ceiling),
    year_floor: yearRange.floor,
    year_ceiling: yearRange.ceiling,
  });
});

/**
 * Los desplegables de la pantalla de ofertas y del editor: las versiones y los
 * dealers activos de la cuenta, con cuántas ofertas activas tiene cada uno.
 * Antes eran `/car-models` y `/dealers` enteros —la mediana y los extremos de
 * cada una de las 2.300 versiones— para pintar un nombre y un número.
 *
 * Va antes de `/:id`: «facets» no es un entero.
 */
offersRoutes.get("/facets", requireUser, async (c) => {
  const db = c.var.db;
  const tenantId = c.var.tenantId;
  const activeOffers = sql<number>`COUNT(${offers.id})`;
  // La cuenta acota versiones y dealers; sus ofertas se siguen por la clave.
  const [models, dealerRows] = await Promise.all([
    db
      .select({
        id: carModels.id,
        make: carModels.make,
        model: carModels.model,
        trim: carModels.trim,
        active_offers: activeOffers,
      })
      .from(carModels)
      .leftJoin(offers, and(eq(offers.car_model_id, carModels.id), eq(offers.status, "active")))
      .where(and(owned(carModels, tenantId), eq(carModels.is_active, true)))
      .groupBy(carModels.id)
      .orderBy(
        sql`lower(${carModels.make})`,
        sql`lower(${carModels.model})`,
        sql`lower(${carModels.trim})`,
      ),
    db
      .select({ id: dealers.id, name: dealers.name, active_offers: activeOffers })
      .from(dealers)
      .leftJoin(offers, and(eq(offers.dealer_id, dealers.id), eq(offers.status, "active")))
      .where(and(owned(dealers, tenantId), eq(dealers.is_active, true)))
      .groupBy(dealers.id)
      .orderBy(desc(activeOffers), asc(dealers.name)),
  ]);
  return c.json({
    car_models: models.map((model) => ({
      id: model.id,
      display_name: modelDisplayName(model),
      active_offers: model.active_offers,
    })),
    dealers: dealerRows,
  });
});

offersRoutes.get("/:id", requireUser, async (c) => {
  return c.json(await respondOne(c, parseId(c, "id")));
});

/** Payload crudo del scraper, desde R2. Se pide aparte: no va en el listado. */
offersRoutes.get("/:id/raw", requireUser, async (c) => {
  const [offer] = await c.var.db
    .select({ raw_ref: offers.raw_ref })
    .from(offers)
    .where(ownedRow(offers, c.var.tenantId, parseId(c, "id")));
  if (!offer) throw notFound("Oferta no encontrada");
  return c.json({ raw: await getRaw(c.env.BUCKET, offer.raw_ref) });
});

offersRoutes.get("/:id/price-history", requireUser, async (c) => {
  const id = parseId(c, "id");
  const db = c.var.db;
  const [exists] = await db
    .select({ id: offers.id })
    .from(offers)
    .where(ownedRow(offers, c.var.tenantId, id));
  if (!exists) throw notFound("Oferta no encontrada");
  const points = await db
    .select({ price: offerPriceHistory.price, recorded_at: offerPriceHistory.recorded_at })
    .from(offerPriceHistory)
    .where(eq(offerPriceHistory.offer_id, id))
    .orderBy(asc(offerPriceHistory.recorded_at), asc(offerPriceHistory.id));
  return c.json(points);
});

// ---- Corrección manual ------------------------------------------------------- //
// El scraper falla en lo de siempre: el año del título, los kilómetros con un
// punto de más, la versión mal resuelta. Solo se tocan `EDITABLE_FIELDS`, y
// cada campo tocado queda anclado para que el siguiente pase no lo deshaga.
offersRoutes.patch("/:id", requireUser, async (c) => {
  const id = parseId(c, "id");
  const payload = await parseBody(c, OfferUpdate);
  const db = c.var.db;
  const tenantId = c.var.tenantId;
  const offer = await getOfferOr404(db, tenantId, id);

  // Reatribuir se comprueba antes de escribir: un 404 con el nombre de lo que
  // no existe, y no un error de clave ajena. Una versión o un dealer de otra
  // cuenta no existen para esta.
  if (
    payload.car_model_id != null &&
    payload.car_model_id !== offer.car_model_id &&
    !(
      await db
        .select({ id: carModels.id })
        .from(carModels)
        .where(ownedRow(carModels, tenantId, payload.car_model_id))
    ).length
  ) {
    throw notFound("Modelo no encontrado");
  }
  if (
    payload.dealer_id != null &&
    payload.dealer_id !== offer.dealer_id &&
    !(
      await db
        .select({ id: dealers.id })
        .from(dealers)
        .where(ownedRow(dealers, tenantId, payload.dealer_id))
    ).length
  ) {
    throw notFound("Dealer no encontrado");
  }

  await applyManualEdit(db, offer, payload, c.var.user.id);
  return c.json(await respondOne(c, id));
});

// ---- Estado: las tres transiciones que se hacen a mano ---------------------- //
// Al volver a ver la oferta, el scraper revive una EXPIRED (el anuncio había
// desaparecido y ha vuelto) y respeta una DISMISSED (decisión de una persona).
async function moveTo(c: Context<AppEnv>, target: OfferStatus, reason: string | null = null) {
  const id = parseId(c, "id");
  const db = c.var.db;
  const tenantId = c.var.tenantId;
  await getOfferOr404(db, tenantId, id);
  const backToActive = target === "active";
  await db
    .update(offers)
    .set({
      status: target,
      dismissed_at: backToActive ? null : nowIso(),
      dismissed_by_id: backToActive ? null : c.var.user.id,
      dismiss_reason: backToActive ? null : reason,
    })
    .where(ownedRow(offers, tenantId, id));
  return c.json(await respondOne(c, id));
}

/** Descarta una oferta. Borrado lógico: el scraper no la revive. */
offersRoutes.delete("/:id", requireUser, async (c) =>
  moveTo(c, "dismissed", await parseBody(c, OfferDismiss)),
);

/** La oferta ya no está en el origen. No es un descarte: el scraper puede revivirla. */
offersRoutes.post("/:id/expire", requireUser, async (c) =>
  moveTo(c, "expired", await parseBody(c, OfferDismiss)),
);

offersRoutes.post("/:id/restore", requireUser, async (c) => moveTo(c, "active"));

// ---- Valoración manual: las dos señales que no están en el anuncio ---------- //
// Endpoint propio y no un campo más del PATCH: aquello ancla contra el scraper,
// y estas notas no las trae ningún origen.
offersRoutes.put("/:id/rating", requireUser, async (c) => {
  const id = parseId(c, "id");
  const payload = await parseBody(c, OfferRatingUpdate);
  const tenantId = c.var.tenantId;
  await getOfferOr404(c.var.db, tenantId, id);
  if (Object.keys(payload).length) {
    await c.var.db.update(offers).set(payload).where(ownedRow(offers, tenantId, id));
  }
  return c.json(await respondOne(c, id));
});

// ---- Favoritos: marca personal, idempotente --------------------------------- //
offersRoutes.post("/:id/favorite", requireUser, async (c) => {
  const id = parseId(c, "id");
  await getOfferOr404(c.var.db, c.var.tenantId, id);
  await c.var.db
    .insert(offerFavorites)
    .values({ user_id: c.var.user.id, offer_id: id })
    .onConflictDoNothing();
  return c.json(await respondOne(c, id));
});

offersRoutes.delete("/:id/favorite", requireUser, async (c) => {
  const id = parseId(c, "id");
  await getOfferOr404(c.var.db, c.var.tenantId, id);
  await c.var.db
    .delete(offerFavorites)
    .where(and(eq(offerFavorites.user_id, c.var.user.id), eq(offerFavorites.offer_id, id)));
  return c.json(await respondOne(c, id));
});
