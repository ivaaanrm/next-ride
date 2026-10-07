import { and, count, desc, eq, sql, type SQL } from "drizzle-orm";

import { router } from "../app";
import { carModels, dealers, offerFavorites, offers, trackedModels } from "../db/schema";
import { roundOrNull } from "../lib/db";
import { parseId } from "../lib/http";
import { owned } from "../lib/tenant";
import { requireUser } from "../middleware";
import { emptyStats, enrichOffers, modelPriceStats } from "../services/metrics";
import { loadOffers, serializeOffers } from "../services/serialize";
import { bestByScore, discountSql } from "./offers";

export const statsRoutes = router();
statsRoutes.use(requireUser);

/** El resumen de la cuenta: todas las cifras son de sus filas. */
statsRoutes.get("/overview", async (c) => {
  const db = c.var.db;
  const tenantId = c.var.tenantId;
  const userId = c.var.user.id;
  const total = (table: typeof offers | typeof dealers | typeof carModels, where: SQL) =>
    db
      .select({ n: count() })
      .from(table)
      .where(and(owned(table, tenantId), where));

  const [[active], [dismissed], [favorites], [dealerCount], [modelCount], [tracked], [discount], candidates] =
    await Promise.all([
      total(offers, eq(offers.status, "active")),
      total(offers, eq(offers.status, "dismissed")),
      db.select({ n: count() }).from(offerFavorites).where(eq(offerFavorites.user_id, userId)),
      total(dealers, eq(dealers.is_active, true)),
      total(carModels, eq(carModels.is_active, true)),
      db
        .select({ n: count() })
        .from(trackedModels)
        .where(and(eq(trackedModels.user_id, userId), eq(trackedModels.is_active, true))),
      db
        .select({ avg: sql<number | null>`AVG(${discountSql()})` })
        .from(offers)
        .where(and(owned(offers, tenantId), eq(offers.status, "active"))),
      // «Mejor chollo»: la mayor puntuación entre las vistas más recientemente,
      // para no puntuar todo el catálogo en cada petición.
      loadOffers(db, tenantId, {
        where: eq(offers.status, "active"),
        orderBy: [desc(offers.last_seen_at)],
        limit: 120,
      }),
    ]);

  const metrics = await enrichOffers(db, tenantId, candidates);
  const top = bestByScore(candidates, (offer) => metrics.get(offer.id)!.value_score);
  const bestDeal = top ? (await serializeOffers(db, tenantId, [top], { metrics }))[0] : null;

  return c.json({
    active_offers: active.n,
    dismissed_offers: dismissed.n,
    favorite_offers: favorites.n,
    dealers: dealerCount.n,
    car_models: modelCount.n,
    tracked_models: tracked.n,
    avg_discount_pct: roundOrNull(discount.avg),
    best_deal: bestDeal,
    ai_enabled: Boolean(c.env.ANTHROPIC_API_KEY),
  });
});

statsRoutes.get("/car-models/:id", async (c) => {
  const id = parseId(c, "id");
  const stats = await modelPriceStats(c.var.db, c.var.tenantId, [id]);
  return c.json(stats.get(id) ?? { car_model_id: id, ...emptyStats() });
});
