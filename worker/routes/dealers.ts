import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { router } from "../app";
import { dealers } from "../db/schema";
import { conflict, notFound, parseBody, parseId, parseQuery, qBool, qString } from "../lib/http";
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

export const dealersRoutes = router();
dealersRoutes.use(requireUser);

dealersRoutes.get("/", async (c) => {
  const query = parseQuery(c, z.object({ q: qString, include_inactive: qBool }));
  const conditions: SQL[] = [];
  if (!query.include_inactive) conditions.push(eq(dealers.is_active, true));
  if (query.q) {
    const pattern = `%${query.q.toLowerCase()}%`;
    conditions.push(sql`(lower(${dealers.name}) LIKE ${pattern} OR lower(${dealers.city}) LIKE ${pattern})`);
  }

  const activeOffers = sql<number>`COUNT(o.id)`;
  const rows = await c.var.db
    .select({
      dealer: dealers,
      active_offers: activeOffers,
      avg_discount: sql<number | null>`AVG(CASE WHEN o.original_price > 0 THEN (o.original_price - o.price) / o.original_price * 100 END)`,
      best_price: sql<number | null>`MIN(o.price)`,
    })
    .from(dealers)
    .leftJoin(sql`offers o`, sql`o.dealer_id = ${dealers.id} AND o.status = 'active'`)
    .where(and(...conditions))
    .groupBy(dealers.id)
    .orderBy(desc(activeOffers), asc(dealers.name));

  return c.json(
    rows.map((row) => ({
      ...dealerRead(row.dealer),
      active_offers: row.active_offers ?? 0,
      avg_discount_pct:
        row.avg_discount === null ? null : Math.round(row.avg_discount * 100) / 100,
      best_price: row.best_price,
    })),
  );
});

dealersRoutes.post("/", async (c) => {
  const { slug: givenSlug, ...payload } = await parseBody(c, DealerCreate);
  const slug = givenSlug || slugify(payload.name);
  const [existing] = await c.var.db.select({ id: dealers.id }).from(dealers).where(eq(dealers.slug, slug));
  if (existing) throw conflict(`Ya existe un dealer con slug '${slug}'`);
  const [dealer] = await c.var.db
    .insert(dealers)
    .values({ ...payload, slug })
    .returning();
  return c.json(dealerRead(dealer), 201);
});

dealersRoutes.get("/:id", async (c) => {
  const [dealer] = await c.var.db.select().from(dealers).where(eq(dealers.id, parseId(c, "id")));
  if (!dealer) throw notFound("Dealer no encontrado");
  return c.json(dealerRead(dealer));
});

dealersRoutes.patch("/:id", async (c) => {
  const id = parseId(c, "id");
  const payload = await parseBody(c, DealerUpdate);
  const db = c.var.db;
  const [dealer] = Object.keys(payload).length
    ? await db.update(dealers).set(payload).where(eq(dealers.id, id)).returning()
    : await db.select().from(dealers).where(eq(dealers.id, id));
  if (!dealer) throw notFound("Dealer no encontrado");
  return c.json(dealerRead(dealer));
});
