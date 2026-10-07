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
import { notFound, parseBody, parseId, parseQuery, qBool, qInt, qNumber, qString } from "../lib/http";
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
import { loadOffer, loadOffers, serializeOffers, type OfferRead } from "../services/serialize";
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

/** Las condiciones del filtro, siempre dentro de las ofertas de la cuenta `userId`. */
export function filterConditions(filters: OfferFilters, userId: string): SQL {
  const conditions: (SQL | undefined)[] = [
    eq(offers.user_id, userId),
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
      sql`EXISTS (SELECT 1 FROM tracked_models t WHERE t.car_model_id = ${offers.car_model_id} AND t.user_id = ${userId} AND t.is_active = 1)`,
    );
  }
  if (filters.favorites_only) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM offer_favorites f WHERE f.offer_id = ${offers.id} AND f.user_id = ${userId})`,
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

const ListQuery = OfferFilters.extend({
  sort: z.enum(SORTS).default("value_score"),
  limit: qInt(z.number().min(1).max(200)).default(50),
  offset: qInt(z.number().min(0)).default(0),
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

/** La oferta `id`, solo si es de la cuenta `userId`. */
const ownOffer = (userId: string, id: number) =>
  and(eq(offers.id, id), eq(offers.user_id, userId));

async function getOfferOr404(db: Db, userId: string, id: number): Promise<OfferWithRelations> {
  const offer = await loadOffer(db, userId, id);
  if (!offer) throw notFound("Oferta no encontrada");
  return offer;
}

async function respondOne(c: Context<AppEnv>, userId: string, id: number) {
  const offer = await getOfferOr404(c.var.db, userId, id);
  return (await serializeOffers(c.var.db, userId, [offer]))[0];
}

export const offersRoutes = router();

// ---- Ingesta: la consume el skill (sesión o X-API-Key) ----------------------- //
// Entra en la cuenta de quien ingesta: la de la sesión o la dueña de la clave.
offersRoutes.post("/", requireIngest, async (c) => {
  // El cuerpo se valida entero antes de tocar nada: aquí un error es un 422.
  const payload = await parseBody(c, OfferIngest);
  const { ownerId } = c.var.principal;
  const result = await ingestOffers(c.env.DB, c.env.BUCKET, ownerId, [payload]);
  if (!result.offer_ids.length) throw new Error(result.errors[0] ?? "No se pudo guardar la oferta");
  return c.json(await respondOne(c, ownerId, result.offer_ids[0]), 201);
});

offersRoutes.post("/bulk", requireIngest, async (c) => {
  const payload = await parseBody(c, OfferBulkIngest);
  return c.json(
    await ingestOffers(c.env.DB, c.env.BUCKET, c.var.principal.ownerId, payload.offers),
  );
});

// ---- Lectura ------------------------------------------------------------------ //
offersRoutes.get("/", requireUser, async (c) => {
  const { sort, limit, offset, ...filters } = parseQuery(c, ListQuery);
  const db = c.var.db;
  const user = c.var.user;
  const where = filterConditions(filters, user.id);

  const [{ total }] = await db.select({ total: count() }).from(offers).where(where);

  const dbSort = DB_SORTS[sort];
  if (dbSort) {
    const list = await loadOffers(db, user.id, {
      where,
      orderBy: [dbSort, asc(offers.id)],
      limit,
      offset,
    });
    return c.json({ items: await serializeOffers(db, user.id, list), total, limit, offset });
  }

  // Ordenación por puntuación: se calcula sobre un conjunto acotado.
  const list = await loadOffers(db, user.id, {
    where,
    orderBy: [asc(offers.price), asc(offers.id)],
    limit: SCORE_SORT_CAP,
  });
  const serialized = await serializeOffers(db, user.id, list);
  const valueOf = (offer: OfferRead) => offer.metrics.value_score ?? 0;
  if (sort === "ai_score") {
    serialized.sort(
      (a, b) =>
        Number(a.ai === null) - Number(b.ai === null) ||
        (b.ai?.score ?? 0) - (a.ai?.score ?? 0) ||
        valueOf(b) - valueOf(a),
    );
  } else {
    serialized.sort((a, b) => valueOf(b) - valueOf(a));
  }
  return c.json({
    items: serialized.slice(offset, offset + limit),
    total: Math.min(total, SCORE_SORT_CAP),
    limit,
    offset,
  });
});

/** Agregados sobre las filas que cumplen el filtro, no sobre todo el catálogo. */
offersRoutes.get("/stats", requireUser, async (c) => {
  const filters = parseQuery(c, OfferFilters);
  const db = c.var.db;
  const user = c.var.user;

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
      .where(filterConditions(filters, user.id)),
    db
      .select({ floor: min(offers.price), ceiling: max(offers.price) })
      .from(offers)
      .where(
        filterConditions({ ...filters, min_price: undefined, max_price: undefined }, user.id),
      ),
    db
      .select({ floor: min(offers.year), ceiling: max(offers.year) })
      .from(offers)
      .where(filterConditions({ ...filters, min_year: undefined, max_year: undefined }, user.id)),
    // El mejor chollo exige puntuar en TS: se acota igual que el orden por
    // puntuación del listado, así ambos coinciden en la fila de arriba.
    loadOffers(db, user.id, {
      where: filterConditions(filters, user.id),
      orderBy: [asc(offers.price), asc(offers.id)],
      limit: SCORE_SORT_CAP,
    }),
  ]);

  let bestDeal: OfferRead | null = null;
  if (candidates.length) {
    const metrics = await enrichOffers(db, user.id, candidates);
    const top = bestByScore(candidates, (offer) => metrics.get(offer.id)!.value_score)!;
    bestDeal = (await serializeOffers(db, user.id, [top]))[0];
  }

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

offersRoutes.get("/:id", requireUser, async (c) => {
  return c.json(await respondOne(c, c.var.user.id, parseId(c, "id")));
});

/** Payload crudo del scraper, desde R2. Se pide aparte: no va en el listado. */
offersRoutes.get("/:id/raw", requireUser, async (c) => {
  const [offer] = await c.var.db
    .select({ raw_ref: offers.raw_ref })
    .from(offers)
    .where(ownOffer(c.var.user.id, parseId(c, "id")));
  if (!offer) throw notFound("Oferta no encontrada");
  return c.json({ raw: await getRaw(c.env.BUCKET, offer.raw_ref) });
});

offersRoutes.get("/:id/price-history", requireUser, async (c) => {
  const id = parseId(c, "id");
  const db = c.var.db;
  const [exists] = await db
    .select({ id: offers.id })
    .from(offers)
    .where(ownOffer(c.var.user.id, id));
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
  const userId = c.var.user.id;
  const offer = await getOfferOr404(db, userId, id);

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
        .where(and(eq(carModels.id, payload.car_model_id), eq(carModels.user_id, userId)))
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
        .where(and(eq(dealers.id, payload.dealer_id), eq(dealers.user_id, userId)))
    ).length
  ) {
    throw notFound("Dealer no encontrado");
  }

  await applyManualEdit(db, offer, payload, userId);
  return c.json(await respondOne(c, userId, id));
});

// ---- Estado: las tres transiciones que se hacen a mano ---------------------- //
// Al volver a ver la oferta, el scraper revive una EXPIRED (el anuncio había
// desaparecido y ha vuelto) y respeta una DISMISSED (decisión de una persona).
async function moveTo(c: Context<AppEnv>, target: OfferStatus, reason: string | null = null) {
  const id = parseId(c, "id");
  const db = c.var.db;
  const userId = c.var.user.id;
  await getOfferOr404(db, userId, id);
  const backToActive = target === "active";
  await db
    .update(offers)
    .set({
      status: target,
      dismissed_at: backToActive ? null : nowIso(),
      dismissed_by_id: backToActive ? null : userId,
      dismiss_reason: backToActive ? null : reason,
    })
    .where(ownOffer(userId, id));
  return c.json(await respondOne(c, userId, id));
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
  const userId = c.var.user.id;
  await getOfferOr404(c.var.db, userId, id);
  if (Object.keys(payload).length) {
    await c.var.db.update(offers).set(payload).where(ownOffer(userId, id));
  }
  return c.json(await respondOne(c, userId, id));
});

// ---- Favoritos: marca personal, idempotente --------------------------------- //
offersRoutes.post("/:id/favorite", requireUser, async (c) => {
  const id = parseId(c, "id");
  const userId = c.var.user.id;
  await getOfferOr404(c.var.db, userId, id);
  await c.var.db
    .insert(offerFavorites)
    .values({ user_id: userId, offer_id: id })
    .onConflictDoNothing();
  return c.json(await respondOne(c, userId, id));
});

offersRoutes.delete("/:id/favorite", requireUser, async (c) => {
  const id = parseId(c, "id");
  const userId = c.var.user.id;
  await getOfferOr404(c.var.db, userId, id);
  await c.var.db
    .delete(offerFavorites)
    .where(and(eq(offerFavorites.user_id, userId), eq(offerFavorites.offer_id, id)));
  return c.json(await respondOne(c, userId, id));
});
