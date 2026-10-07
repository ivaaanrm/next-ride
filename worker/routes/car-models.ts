import { and, asc, count, eq, max, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { router } from "../app";
import { carModels, rankingRuns, trackedModels, type CarModel } from "../db/schema";
import { inList, round, type Db } from "../lib/db";
import {
  conflict,
  notFound,
  PageQuery,
  parseBody,
  parseId,
  parseQuery,
  qBool,
  qString,
} from "../lib/http";
import { owned, ownedRow } from "../lib/tenant";
import { requireUser } from "../middleware";
import { nullable } from "../schemas/common";
import { DEFAULT_PARAMS } from "../schemas/scoring";
import { makeModelKey, slugify } from "../services/catalog";
import { binomioMarket, modelPriceStats, type PriceStats } from "../services/metrics";
import { carModelRead, trackedPrefs } from "../services/serialize";

type CarModelWithStats = Awaited<ReturnType<typeof withStats>>[number];

/**
 * Las versiones con sus agregados y el seguimiento de la cuenta. Quien ya tiene
 * los agregados (los grupos, que los sacan de las filas del mercado del
 * binomio) los pasa en `known` y no se vuelven a leer las ofertas.
 */
async function withStats(
  db: Db,
  tenantId: string,
  models: CarModel[],
  known?: Map<number, PriceStats>,
) {
  if (!models.length) return [];
  const ids = models.map((model) => model.id);
  const [stats, tracked] = await Promise.all([
    known ?? modelPriceStats(db, tenantId, ids),
    db
      .select()
      .from(trackedModels)
      .where(
        and(
          eq(trackedModels.user_id, tenantId),
          inList(trackedModels.car_model_id, ids),
          eq(trackedModels.is_active, true),
        ),
      ),
  ]);
  const prefs = new Map(tracked.map((row) => [row.car_model_id, trackedPrefs(row)]));

  return models.map((model) => {
    const stat = stats.get(model.id);
    const tracking = prefs.get(model.id) ?? null;
    return {
      ...carModelRead(model),
      active_offers: stat?.count ?? 0,
      min_price: stat?.min_price ?? null,
      median_price: stat?.median_price ? round(stat.median_price, 2) : null,
      max_price: stat?.max_price ?? null,
      dealers_count: stat?.dealers_count ?? 0,
      is_tracked: tracking !== null,
      // Criterios del usuario actual; `null` si no lo sigue. El ranking de IA
      // no vive aquí: es del binomio, no de la versión (`last_ranked_at`).
      tracking,
    };
  });
}

/** Mediana de una lista ya ordenada (la de los PVP de las versiones). */
function medianOfSorted(values: number[]): number | null {
  if (!values.length) return null;
  const middle = Math.floor(values.length / 2);
  if (values.length % 2) return values[middle];
  return round((values[middle - 1] + values[middle]) / 2, 2);
}

const ListQuery = z.object({ q: qString, tracked_only: qBool, include_inactive: qBool });

const trackedByUser = (tenantId: string) =>
  sql`EXISTS (SELECT 1 FROM tracked_models t WHERE t.car_model_id = ${carModels.id} AND t.user_id = ${tenantId} AND t.is_active = 1)`;

/** Las versiones de la cuenta que casan con la búsqueda. */
function listConditions(query: z.output<typeof ListQuery>, tenantId: string): SQL[] {
  const conditions: SQL[] = [owned(carModels, tenantId)];
  if (!query.include_inactive) conditions.push(eq(carModels.is_active, true));
  if (query.q) {
    const pattern = `%${query.q.toLowerCase()}%`;
    conditions.push(
      sql`(lower(${carModels.make}) LIKE ${pattern} OR lower(${carModels.model}) LIKE ${pattern} OR lower(${carModels.slug}) LIKE ${pattern})`,
    );
  }
  if (query.tracked_only) conditions.push(trackedByUser(tenantId));
  return conditions;
}

const CarModelCreate = z.object({
  make: z.string().min(1).max(80),
  model: z.string().min(1).max(120),
  trim: z.string().max(120).default(""),
  body_type: nullable(z.string().max(40)),
  reference_price: nullable(z.number().min(0)),
});

const CarModelUpdate = z
  .object({
    body_type: z.string().max(40).nullable(),
    reference_price: z.number().min(0).nullable(),
    is_active: z.boolean(),
  })
  .partial();

/** El catálogo es de cada cuenta: lo forman sus ofertas y lo que ella sigue. */
export const carModelsRoutes = router();
carModelsRoutes.use(requireUser);

/**
 * Las versiones de la cuenta, por páginas y con sus agregados: solo los de la
 * página, que son los únicos que se leen.
 */
carModelsRoutes.get("/", async (c) => {
  const { limit, offset, ...query } = parseQuery(c, ListQuery.extend(PageQuery.shape));
  const db = c.var.db;
  const tenantId = c.var.tenantId;
  const where = and(...listConditions(query, tenantId));

  const [[{ total }], models] = await Promise.all([
    db.select({ total: count() }).from(carModels).where(where),
    db
      .select()
      .from(carModels)
      .where(where)
      .orderBy(
        sql`lower(${carModels.make})`,
        sql`lower(${carModels.model})`,
        sql`lower(${carModels.trim})`,
        asc(carModels.id),
      )
      .limit(limit)
      .offset(offset),
  ]);
  return c.json({ items: await withStats(db, tenantId, models), total, limit, offset });
});

/**
 * El catálogo por binomio marca-modelo, con las versiones colgando.
 *
 * `car_models` está partido por acabado —un «Audi A3» son veintitrés filas— y
 * a ese nivel el listado enseña una oferta por fila. El binomio es la unidad
 * con la que se mira un mercado, la misma que usa `/analytics/segments`.
 *
 * Va antes de `/:id`: «groups» no es un entero.
 */
carModelsRoutes.get("/groups", async (c) => {
  const query = parseQuery(c, ListQuery);
  const db = c.var.db;
  const tenantId = c.var.tenantId;

  // Dos pasos: qué binomios casan con el filtro y luego *todas* sus versiones.
  // Buscar «sportback» encuentra el A3 entero, no tres de sus versiones: un
  // grupo recortado daría una mediana que no es la del mercado que describe.
  // Basta con seguir una versión para que el binomio esté en la lista.
  const keyRows = await db
    .selectDistinct({ key: carModels.make_model_key })
    .from(carModels)
    .where(and(...listConditions(query, tenantId)));
  const keys = keyRows.map((row) => row.key);
  if (!keys.length) return c.json([]);

  const models = await db
    .select()
    .from(carModels)
    .where(
      and(
        owned(carModels, tenantId),
        inList(carModels.make_model_key, keys),
        query.include_inactive ? undefined : eq(carModels.is_active, true),
      ),
    )
    // En minúsculas, que es de lo que está hecha la clave: si no, las dos
    // grafías de un binomio se separarían y sus versiones dejarían de ser
    // contiguas. Por marca y luego modelo, y no por la clave entera: el «|» de
    // en medio pondría «mercedes-benz» antes que «mercedes».
    .orderBy(sql`lower(${carModels.make})`, sql`lower(${carModels.model})`, sql`lower(${carModels.trim})`);

  // Una sola lectura de las ofertas: los agregados de cada versión salen de
  // las mismas filas que el mercado del binomio.
  const marketQuery = binomioMarket(
    db,
    tenantId,
    keys,
    DEFAULT_PARAMS,
    new Date(),
    models.map((model) => model.id),
  );
  const [market, variants, ranked] = await Promise.all([
    marketQuery,
    marketQuery.then((market) => withStats(db, tenantId, models, market.variants)),
    db
      .select({ key: rankingRuns.make_model_key, last: max(rankingRuns.created_at) })
      .from(rankingRuns)
      .where(
        and(
          owned(rankingRuns, tenantId),
          inList(rankingRuns.make_model_key, keys),
          eq(rankingRuns.status, "completed"),
        ),
      )
      .groupBy(rankingRuns.make_model_key),
  ]);
  const lastRanked = new Map(ranked.map((row) => [row.key, row.last]));

  const groups = new Map<string, Record<string, unknown> & { variants: CarModelWithStats[] }>();
  models.forEach((model, index) => {
    const key = model.make_model_key;
    const variant = variants[index];
    let group = groups.get(key);
    if (!group) {
      const stat = market.stats.get(key);
      // Sin ofertas activas no hay grafía más frecuente: se cae a la de la versión.
      group = {
        key,
        make: stat?.make ?? variant.make,
        model: stat?.model ?? variant.model,
        variants: [],
        active_offers: stat?.count ?? 0,
        min_price: stat?.min_price ?? null,
        median_price: stat?.median_price ?? null,
        max_price: stat?.max_price ?? null,
        dealers_count: stat?.dealers_count ?? 0,
        last_ranked_at: lastRanked.get(key) ?? null,
      };
      groups.set(key, group);
    }
    group.variants.push(variant);
  });

  return c.json(
    [...groups.values()].map((group) => {
      const tracked = group.variants.flatMap((variant) => (variant.tracking ? [variant.tracking] : []));
      const targets = tracked.flatMap((t) => (t.target_price !== null ? [t.target_price] : []));
      // El PVP es de la versión: el binomio enseña la mediana de las que lo
      // tienen y dice cuántas son, para no aparentar describir el binomio entero.
      const references = group.variants
        .flatMap((variant) => (variant.reference_price !== null ? [variant.reference_price] : []))
        .sort((a, b) => a - b);
      return {
        ...group,
        reference_price: medianOfSorted(references),
        reference_variants: references.length,
        tracked_variants: tracked.length,
        // El objetivo más bajo: el que decide si ya hay algo que mirar.
        target_price: targets.length ? Math.min(...targets) : null,
        label: `${group.make} ${group.model}`,
        variant_count: group.variants.length,
      };
    }),
  );
});

carModelsRoutes.post("/", async (c) => {
  const payload = await parseBody(c, CarModelCreate);
  const tenantId = c.var.tenantId;
  const slug = slugify(payload.make, payload.model, payload.trim);
  const [existing] = await c.var.db
    .select({ id: carModels.id })
    .from(carModels)
    .where(and(owned(carModels, tenantId), eq(carModels.slug, slug)));
  if (existing) throw conflict(`Ya existe el modelo '${slug}'`);
  const [model] = await c.var.db
    .insert(carModels)
    .values({
      ...payload,
      user_id: tenantId,
      slug,
      make_model_key: makeModelKey(payload.make, payload.model),
    })
    .returning();
  return c.json(carModelRead(model), 201);
});

carModelsRoutes.get("/:id", async (c) => {
  const tenantId = c.var.tenantId;
  const [model] = await c.var.db
    .select()
    .from(carModels)
    .where(ownedRow(carModels, tenantId, parseId(c, "id")));
  if (!model) throw notFound("Modelo no encontrado");
  return c.json((await withStats(c.var.db, tenantId, [model]))[0]);
});

carModelsRoutes.patch("/:id", async (c) => {
  const id = parseId(c, "id");
  const payload = await parseBody(c, CarModelUpdate);
  const db = c.var.db;
  const where = ownedRow(carModels, c.var.tenantId, id);
  const [model] = Object.keys(payload).length
    ? await db.update(carModels).set(payload).where(where).returning()
    : await db.select().from(carModels).where(where);
  if (!model) throw notFound("Modelo no encontrado");
  return c.json(carModelRead(model));
});
