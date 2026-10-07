/**
 * Métricas derivadas de las ofertas.
 *
 * Se calculan al leer (no se persisten) para que sigan siendo correctas cuando
 * entran ofertas nuevas y la mediana del modelo se mueve.
 *
 * El mercado contra el que se mide una oferta es su **binomio marca-modelo**, no
 * su fila de `car_models`: el catálogo está partido por acabado y la mayoría de
 * versiones tienen una sola oferta, así que su mediana sería el propio precio
 * del coche («justo en mercado» comparándolo consigo mismo). Es además la
 * mediana con la que rankea el agente de IA.
 *
 * Y es el mercado **de la cuenta**: sus ofertas, no las de todas. Una mediana
 * sobre las ofertas de otras cuentas diría de ellas lo que no se puede ver.
 */
import { and, eq, sql } from "drizzle-orm";

import {
  carModels,
  offerPriceHistory,
  offers,
  type CarModel,
  type Dealer,
  type Offer,
  type VehicleCondition,
} from "../db/schema";
import { inList, round, type Db } from "../lib/db";
import { average, maxOf, median, minOf, mode } from "../lib/stats";
import { owned } from "../lib/tenant";
import type { ScoreBreakdownItem, ScoreParams } from "../schemas/scoring";
import {
  DEFAULT_CONFIG,
  expectedPrice,
  getScoringConfig,
  marketNewPrice,
  scoreOffer,
  type ScoringConfig,
} from "./scoring";

export type OfferWithRelations = Offer & { car_model: CarModel; dealer: Dealer };

/**
 * Agregados de precio sobre un conjunto de ofertas activas. Los comparten la
 * versión y el binomio: `computeMetrics` puntúa contra el mercado que le pasen.
 */
export interface PriceStats {
  count: number;
  min_price: number | null;
  median_price: number | null;
  max_price: number | null;
  avg_price: number | null;
  avg_mileage_km: number | null;
  avg_year: number | null;
  dealers_count: number;
}

export interface ModelPriceStats extends PriceStats {
  car_model_id: number;
}

/**
 * Los mismos agregados, pero del binomio entero. No se componen a partir de
 * los de cada versión: ni la mediana sale de las medianas de sus partes, ni los
 * dealers distintos de sumar los de cada una.
 */
export interface MakeModelPriceStats extends PriceStats {
  key: string;
  make: string;
  model: string;
  versions: number;
}

export interface OfferMetrics {
  discount_pct: number | null;
  price_vs_median_pct: number | null;
  price_vs_reference_pct: number | null;
  price_drop_pct: number | null;
  days_listed: number;
  km_per_year: number | null;
  expected_price_eur: number | null;
  price_vs_expected_pct: number | null;
  expected_price_source: "pvp" | "mercado" | null;
  value_score: number | null;
  score_breakdown: ScoreBreakdownItem[];
}

export const emptyMetrics = (): OfferMetrics => ({
  discount_pct: null,
  price_vs_median_pct: null,
  price_vs_reference_pct: null,
  price_drop_pct: null,
  days_listed: 0,
  km_per_year: null,
  expected_price_eur: null,
  price_vs_expected_pct: null,
  expected_price_source: null,
  value_score: null,
  score_breakdown: [],
});

export const emptyStats = (): PriceStats => ({
  count: 0,
  min_price: null,
  median_price: null,
  max_price: null,
  avg_price: null,
  avg_mileage_km: null,
  avg_year: null,
  dealers_count: 0,
});

interface MarketRow {
  car_model_id: number;
  price: number;
  mileage_km: number | null;
  year: number | null;
  dealer_id: number;
  condition: VehicleCondition;
}

function aggregate(rows: MarketRow[]): PriceStats {
  const prices = rows.map((row) => row.price);
  return {
    count: rows.length,
    min_price: minOf(prices),
    median_price: median(prices),
    max_price: maxOf(prices),
    avg_price: average(prices),
    avg_mileage_km: average(rows.map((row) => row.mileage_km)),
    avg_year: average(rows.map((row) => row.year)),
    dealers_count: new Set(rows.map((row) => row.dealer_id)).size,
  };
}

/**
 * Agregados de precio por versión, sobre las ofertas activas de la cuenta.
 *
 * La cuenta acota las versiones y las ofertas se siguen por su clave
 * (`lib/tenant.ts`): con `offers.user_id` en el filtro, SQLite recorría todas
 * las ofertas de la cuenta para sacar las de una versión.
 */
export async function modelPriceStats(
  db: Db,
  tenantId: string,
  carModelIds: number[],
): Promise<Map<number, ModelPriceStats>> {
  const result = new Map<number, ModelPriceStats>();
  if (!carModelIds.length) return result;

  const rows = await db
    .select({
      car_model_id: offers.car_model_id,
      price: offers.price,
      mileage_km: offers.mileage_km,
      year: offers.year,
      dealer_id: offers.dealer_id,
      condition: offers.condition,
    })
    .from(carModels)
    .innerJoin(offers, eq(offers.car_model_id, carModels.id))
    .where(
      and(
        owned(carModels, tenantId),
        inList(carModels.id, carModelIds),
        eq(offers.status, "active"),
      ),
    );

  const grouped = Map.groupBy(rows, (row) => row.car_model_id);
  // Las versiones sin ofertas activas también aparecen, con contadores a cero.
  for (const id of carModelIds) {
    result.set(id, { car_model_id: id, ...aggregate(grouped.get(id) ?? []) });
  }
  return result;
}

export interface BinomioMarket {
  stats: Map<string, MakeModelPriceStats>;
  /** PVP estimado por binomio (curva invertida), el ancla de reserva del valor esperado. */
  anchors: Map<string, number>;
  /**
   * Los agregados de cada versión, de las mismas filas: lo que daría
   * `modelPriceStats` sin volver a leer las ofertas. Una versión sin ofertas
   * activas no está.
   */
  variants: Map<number, PriceStats>;
}

/**
 * El mercado de unos binomios en la cuenta: sus agregados y su PVP estimado,
 * con una sola consulta sobre las ofertas activas de todas sus versiones (o
 * solo de `onlyModelIds`, cuando el listado que lo pide ha dejado fuera alguna).
 *
 * La raíz son las versiones de la cuenta con esa clave; sus ofertas se siguen
 * por `car_model_id` (`lib/tenant.ts`).
 */
export async function binomioMarket(
  db: Db,
  tenantId: string,
  keys: Iterable<string>,
  params: ScoreParams,
  now: Date = new Date(),
  onlyModelIds?: number[],
): Promise<BinomioMarket> {
  const keyList = [...new Set(keys)];
  const market: BinomioMarket = { stats: new Map(), anchors: new Map(), variants: new Map() };
  if (!keyList.length) return market;

  const rows = await db
    .select({
      key: carModels.make_model_key,
      make: carModels.make,
      model: carModels.model,
      car_model_id: offers.car_model_id,
      price: offers.price,
      mileage_km: offers.mileage_km,
      year: offers.year,
      dealer_id: offers.dealer_id,
      condition: offers.condition,
    })
    .from(carModels)
    .innerJoin(offers, eq(offers.car_model_id, carModels.id))
    .where(
      and(
        owned(carModels, tenantId),
        inList(carModels.make_model_key, keyList),
        eq(offers.status, "active"),
        onlyModelIds ? inList(offers.car_model_id, onlyModelIds) : undefined,
      ),
    );

  const nowYear = now.getUTCFullYear();
  for (const [key, group] of Map.groupBy(rows, (row) => row.key)) {
    const stats = aggregate(group);
    market.stats.set(key, {
      key,
      // La grafía más frecuente, no la que gane alfabéticamente: «A4 Allroad
      // Quattro» y «A4 Allroad quattro» son el mismo binomio.
      make: mode(group.map((row) => row.make)) ?? "",
      model: mode(group.map((row) => row.model)) ?? "",
      ...stats,
      median_price: stats.median_price === null ? null : round(stats.median_price, 2),
      versions: new Set(group.map((row) => row.car_model_id)).size,
    });
    const anchor = marketNewPrice(group, params, nowYear);
    if (anchor !== null) market.anchors.set(key, anchor);
  }
  for (const [id, group] of Map.groupBy(rows, (row) => row.car_model_id)) {
    market.variants.set(id, aggregate(group));
  }
  return market;
}

/**
 * Primer precio registrado por oferta, para calcular la bajada. Con `MIN()`,
 * SQLite devuelve las columnas sueltas de la fila del mínimo.
 */
export async function firstSeenPrices(db: Db, offerIds: number[]): Promise<Map<number, number>> {
  if (!offerIds.length) return new Map();
  const rows = await db
    .select({
      offer_id: offerPriceHistory.offer_id,
      price: offerPriceHistory.price,
      first_at: sql<string>`MIN(${offerPriceHistory.recorded_at})`,
    })
    .from(offerPriceHistory)
    .where(inList(offerPriceHistory.offer_id, offerIds))
    .groupBy(offerPriceHistory.offer_id);
  return new Map(rows.map((row) => [row.offer_id, row.price]));
}

const DAY_MS = 86_400_000;

/**
 * Las métricas de una oferta contra el mercado que le pasen. `marketNewPrice`
 * es el PVP estimado del binomio, el ancla de reserva cuando la versión no
 * tiene `reference_price` curado.
 */
export function computeMetrics(
  offer: OfferWithRelations,
  stats: PriceStats | null | undefined,
  initialPrice: number | null | undefined,
  config: ScoringConfig = DEFAULT_CONFIG,
  marketNewPriceEur: number | null | undefined = null,
  now: Date = new Date(),
): OfferMetrics {
  const price = offer.price;
  const metrics = emptyMetrics();

  if (offer.original_price && offer.original_price > 0) {
    metrics.discount_pct = round(((offer.original_price - price) / offer.original_price) * 100, 2);
  }

  if (stats?.median_price) {
    metrics.price_vs_median_pct = round(
      ((price - stats.median_price) / stats.median_price) * 100,
      2,
    );
  }

  const reference = offer.car_model?.reference_price ?? null;
  if (reference && reference > 0) {
    metrics.price_vs_reference_pct = round(((price - reference) / reference) * 100, 2);
  }

  if (initialPrice && initialPrice > 0 && initialPrice !== price) {
    metrics.price_drop_pct = round(((initialPrice - price) / initialPrice) * 100, 2);
  }

  if (offer.first_seen_at) {
    const elapsed = now.getTime() - Date.parse(offer.first_seen_at);
    metrics.days_listed = Math.max(Math.floor(elapsed / DAY_MS), 0);
  }

  if (offer.mileage_km !== null && offer.year) {
    const age = Math.max(now.getUTCFullYear() - offer.year, 1);
    metrics.km_per_year = round(offer.mileage_km / age, 1);
  }

  // Valor esperado por depreciación media (edad + km). El ancla preferente es
  // el PVP curado de la versión; sin él, el estimado del mercado del binomio.
  const curated = reference && reference > 0 ? reference : null;
  const anchor = curated ?? marketNewPriceEur;
  const expected = expectedPrice(offer, anchor, config.params, now.getUTCFullYear());
  if (expected && expected > 0) {
    metrics.expected_price_eur = expected;
    metrics.price_vs_expected_pct = round(((price - expected) / expected) * 100, 2);
    metrics.expected_price_source = curated ? "pvp" : "mercado";
  }

  [metrics.value_score, metrics.score_breakdown] = scoreOffer(
    offer,
    stats,
    metrics,
    initialPrice,
    config,
    now,
  );
  return metrics;
}

/**
 * Las métricas de cada oferta, indexadas por `offer.id`, contra el mercado y
 * con los pesos de la cuenta `tenantId`, que es la dueña de `list`.
 */
export async function enrichOffers(
  db: Db,
  tenantId: string,
  list: OfferWithRelations[],
  config?: ScoringConfig,
): Promise<Map<number, OfferMetrics>> {
  if (!list.length) return new Map();
  const scoring = config ?? (await getScoringConfig(db, tenantId));
  const now = new Date();
  const [market, initialPrices] = await Promise.all([
    binomioMarket(
      db,
      tenantId,
      list.map((offer) => offer.car_model.make_model_key),
      scoring.params,
      now,
    ),
    firstSeenPrices(
      db,
      list.map((offer) => offer.id),
    ),
  ]);

  return new Map(
    list.map((offer) => {
      const key = offer.car_model.make_model_key;
      return [
        offer.id,
        computeMetrics(
          offer,
          market.stats.get(key),
          initialPrices.get(offer.id),
          scoring,
          market.anchors.get(key),
          now,
        ),
      ];
    }),
  );
}
