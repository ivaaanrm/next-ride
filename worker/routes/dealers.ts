import { and, asc, count, desc, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { router } from "../app";
import { dealers } from "../db/schema";
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
import { slugify } from "../services/catalog";
import { dealerRead } from "../services/serialize";

const DealerFields = {
  name: z.string().min(1).max(200),
  website: nullable(z.string().max(500)),
  city: nullable(z.string().max(120)),
  country: nullable(z.string().min(2).max(2)),
  rating: nullable(z.number().min(0).max(5)),
  notes: nullable(z.string().max(1000)),
};

const DealerCreate = z.object({ ...DealerFields, slug: nullable(z.string().max(140)) });

const DealerUpdate = z
  .object({
    name: z.string().min(1).max(200),
    website: z.string().max(500).nullable(),
    city: z.string().max(120).nullable(),
    country: z.string().min(2).max(2).nullable(),
    rating: z.number().min(0).max(5).nullable(),
    is_active: z.boolean(),
    notes: z.string().max(1000).nullable(),
  })
  .partial();

/**
 * Los dealers son de cada cuenta: los crea su ingesta, y sus notas y su
 * valoración son de quien las escribe.
 */
export const dealersRoutes = router();
dealersRoutes.use(requireUser);

const ListQuery = PageQuery.extend({ q: qString, include_inactive: qBool });

/**
 * Los dealers de la cuenta con sus agregados, de los que más ofertas activas
 * tienen a los que menos.
 *
 * Las ofertas se cuentan por `dealer_id` y nada más: el dealer ya es de la
 * cuenta, y por los disparadores de la 0003 sus ofertas también. Con
 * `o.user_id = ?` en la unión, SQLite elegía el índice de la cuenta y recorría
 * todas sus ofertas por cada dealer: 2,6 millones de filas y 8 s en producción
 * para 285 dealers (ver `lib/tenant.ts`).
 */
dealersRoutes.get("/", async (c) => {
  const { limit, offset, ...query } = parseQuery(c, ListQuery);
  const conditions: SQL[] = [owned(dealers, c.var.tenantId)];
  if (!query.include_inactive) conditions.push(eq(dealers.is_active, true));
  if (query.q) {
    const pattern = `%${query.q.toLowerCase()}%`;
    conditions.push(sql`(lower(${dealers.name}) LIKE ${pattern} OR lower(${dealers.city}) LIKE ${pattern})`);
  }
  const where = and(...conditions);

  const activeOffers = sql<number>`COUNT(o.id)`;
  const [[{ total }], rows] = await Promise.all([
    c.var.db.select({ total: count() }).from(dealers).where(where),
    c.var.db
      .select({
        dealer: dealers,
        active_offers: activeOffers,
        avg_discount: sql<number | null>`AVG(CASE WHEN o.original_price > 0 THEN (o.original_price - o.price) / o.original_price * 100 END)`,
        best_price: sql<number | null>`MIN(o.price)`,
      })
      .from(dealers)
      .leftJoin(sql`offers o`, sql`o.dealer_id = ${dealers.id} AND o.status = 'active'`)
      .where(where)
      .groupBy(dealers.id)
      // El id desempata: sin él, dos dealers con las mismas ofertas y el mismo
      // nombre podrían cambiar de página entre una petición y la siguiente.
      .orderBy(desc(activeOffers), asc(dealers.name), asc(dealers.id))
      .limit(limit)
      .offset(offset),
  ]);

  return c.json({
    items: rows.map((row) => ({
      ...dealerRead(row.dealer),
      active_offers: row.active_offers ?? 0,
      avg_discount_pct:
        row.avg_discount === null ? null : Math.round(row.avg_discount * 100) / 100,
      best_price: row.best_price,
    })),
    total,
    limit,
    offset,
  });
});

dealersRoutes.post("/", async (c) => {
  const { slug: givenSlug, ...payload } = await parseBody(c, DealerCreate);
  const tenantId = c.var.tenantId;
  const slug = givenSlug || slugify(payload.name);
  const [existing] = await c.var.db
    .select({ id: dealers.id })
    .from(dealers)
    .where(and(owned(dealers, tenantId), eq(dealers.slug, slug)));
  if (existing) throw conflict(`Ya existe un dealer con slug '${slug}'`);
  const [dealer] = await c.var.db
    .insert(dealers)
    .values({ ...payload, user_id: tenantId, slug })
    .returning();
  return c.json(dealerRead(dealer), 201);
});

dealersRoutes.get("/:id", async (c) => {
  const [dealer] = await c.var.db
    .select()
    .from(dealers)
    .where(ownedRow(dealers, c.var.tenantId, parseId(c, "id")));
  if (!dealer) throw notFound("Dealer no encontrado");
  return c.json(dealerRead(dealer));
});

dealersRoutes.patch("/:id", async (c) => {
  const id = parseId(c, "id");
  const payload = await parseBody(c, DealerUpdate);
  const db = c.var.db;
  const where = ownedRow(dealers, c.var.tenantId, id);
  const [dealer] = Object.keys(payload).length
    ? await db.update(dealers).set(payload).where(where).returning()
    : await db.select().from(dealers).where(where);
  if (!dealer) throw notFound("Dealer no encontrado");
  return c.json(dealerRead(dealer));
});
