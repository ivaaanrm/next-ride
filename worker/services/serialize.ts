/**
 * Las formas de respuesta de la API, campo a campo las de los esquemas Pydantic
 * de antes: son las que tipa `src/types.ts` en el frontend.
 */
import { and, eq, max, type SQL } from "drizzle-orm";

import {
  carModels,
  dealers,
  offerRankings,
  offers,
  rankingRuns,
  type ApiKey,
  type CarModel,
  type Dealer,
  type ScrapeSource,
  type ScrapeTarget,
  type TrackedModel,
  type User,
} from "../db/schema";
import { inList, type Db } from "../lib/db";
import { enrichOffers, type OfferMetrics, type OfferWithRelations } from "./metrics";
import { favoriteOfferIds } from "./offers";
import type { ScoringConfig } from "./scoring";

export const dealerRead = (dealer: Dealer) => ({
  id: dealer.id,
  slug: dealer.slug,
  name: dealer.name,
  website: dealer.website,
  city: dealer.city,
  country: dealer.country,
  rating: dealer.rating,
  is_active: dealer.is_active,
  notes: dealer.notes,
  created_at: dealer.created_at,
});

export const carModelRead = (model: CarModel) => ({
  id: model.id,
  slug: model.slug,
  make: model.make,
  model: model.model,
  trim: model.trim,
  body_type: model.body_type,
  reference_price: model.reference_price,
  is_active: model.is_active,
  display_name: [model.make, model.model, model.trim].filter(Boolean).join(" "),
});

export const trackedPrefs = (row: TrackedModel) => ({
  id: row.id,
  target_price: row.target_price,
  max_mileage_km: row.max_mileage_km,
  min_year: row.min_year,
  notes: row.notes,
});

export const trackedModelRead = (row: TrackedModel, model: CarModel) => ({
  id: row.id,
  car_model_id: row.car_model_id,
  target_price: row.target_price,
  max_mileage_km: row.max_mileage_km,
  min_year: row.min_year,
  is_active: row.is_active,
  notes: row.notes,
  car_model: carModelRead(model),
});

export const apiKeyRead = (key: ApiKey) => ({
  id: key.id,
  name: key.name,
  prefix: key.prefix,
  is_active: key.is_active,
  created_at: key.created_at,
  last_used_at: key.last_used_at,
});

export const userRead = (user: Pick<User, "id" | "email" | "name" | "isActive" | "isSuperuser" | "createdAt" | "lastLoginAt">) => ({
  id: user.id,
  email: user.email,
  full_name: user.name || null,
  is_active: user.isActive,
  is_superuser: user.isSuperuser,
  created_at: new Date(user.createdAt).toISOString(),
  last_login_at: user.lastLoginAt ? new Date(user.lastLoginAt).toISOString() : null,
});

export const scrapeSourceRead = (source: ScrapeSource) => ({
  id: source.id,
  key: source.key,
  name: source.name,
  base_url: source.base_url,
  search_url_template: source.search_url_template,
  listing_url: source.listing_url,
  access: source.access,
  notes: source.notes,
  config: source.config,
  is_active: source.is_active,
  created_at: source.created_at,
  updated_at: source.updated_at,
});

export const scrapeTargetRead = (target: ScrapeTarget, source: ScrapeSource) => ({
  id: target.id,
  source_id: target.source_id,
  make_model_key: target.make_model_key,
  make: target.make,
  model: target.model,
  max_results: target.max_results,
  search_url: target.search_url,
  search_params: target.search_params,
  is_active: target.is_active,
  created_at: target.created_at,
  updated_at: target.updated_at,
  source: scrapeSourceRead(source),
});

// --------------------------------------------------------------------------- //
// Ofertas
// --------------------------------------------------------------------------- //
export interface OfferRankSummary {
  rank: number;
  score: number;
  verdict: string;
  reasoning: string | null;
  run_id: number;
  ranked_at: string;
}

export type OfferRead = ReturnType<typeof offerRead>;

export function offerRead(
  offer: OfferWithRelations,
  metrics: OfferMetrics,
  ai: OfferRankSummary | null = null,
  isFavorite = false,
) {
  return {
    id: offer.id,
    url: offer.url,
    external_id: offer.external_id,
    source: offer.source,
    title: offer.title,
    price: offer.price,
    original_price: offer.original_price,
    currency: offer.currency,
    year: offer.year,
    mileage_km: offer.mileage_km,
    power_hp: offer.power_hp,
    condition: offer.condition,
    fuel_type: offer.fuel_type,
    transmission: offer.transmission,
    location: offer.location,
    image_url: offer.image_url,
    status: offer.status,
    first_seen_at: offer.first_seen_at,
    last_seen_at: offer.last_seen_at,
    dismissed_at: offer.dismissed_at,
    dismiss_reason: offer.dismiss_reason,
    dealer: dealerRead(offer.dealer),
    car_model: carModelRead(offer.car_model),
    metrics,
    ai,
    is_favorite: isFavorite,
    manual_fields: offer.manual_fields ?? [],
    edited_at: offer.edited_at,
    equipment_rating: offer.equipment_rating,
    apparent_condition_rating: offer.apparent_condition_rating,
  };
}

/** Ofertas con su versión y su dealer, con el filtro y el orden que se pidan. */
export async function loadOffers(
  db: Db,
  options: {
    where?: SQL;
    orderBy?: SQL[];
    limit?: number;
    offset?: number;
  } = {},
): Promise<OfferWithRelations[]> {
  let query = db
    .select({ offer: offers, car_model: carModels, dealer: dealers })
    .from(offers)
    .innerJoin(carModels, eq(carModels.id, offers.car_model_id))
    .innerJoin(dealers, eq(dealers.id, offers.dealer_id))
    .where(options.where)
    .$dynamic();
  if (options.orderBy?.length) query = query.orderBy(...options.orderBy);
  if (options.limit !== undefined) query = query.limit(options.limit);
  if (options.offset) query = query.offset(options.offset);
  const rows = await query;
  return rows.map((row) => ({ ...row.offer, car_model: row.car_model, dealer: row.dealer }));
}

export async function loadOffer(db: Db, id: number): Promise<OfferWithRelations | null> {
  const [offer] = await loadOffers(db, { where: eq(offers.id, id) });
  return offer ?? null;
}

/**
 * Último veredicto del agente por oferta, del run completado más reciente de su
 * binomio: dos versiones del mismo modelo comparten ranking.
 */
export async function latestAiSummaries(
  db: Db,
  list: OfferWithRelations[],
): Promise<Map<number, OfferRankSummary>> {
  if (!list.length) return new Map();
  const keys = [...new Set(list.map((offer) => offer.car_model.make_model_key))];
  const latest = await db
    .select({ id: max(rankingRuns.id) })
    .from(rankingRuns)
    .where(and(inList(rankingRuns.make_model_key, keys), eq(rankingRuns.status, "completed")))
    .groupBy(rankingRuns.make_model_key);
  const runIds = latest.map((row) => row.id).filter((id): id is number => id !== null);
  if (!runIds.length) return new Map();

  const rows = await db
    .select({ item: offerRankings, created_at: rankingRuns.created_at })
    .from(offerRankings)
    .innerJoin(rankingRuns, eq(rankingRuns.id, offerRankings.run_id))
    .where(
      and(
        inList(offerRankings.run_id, runIds),
        inList(
          offerRankings.offer_id,
          list.map((offer) => offer.id),
        ),
      ),
    );
  return new Map(
    rows.map(({ item, created_at }) => [
      item.offer_id,
      {
        rank: item.rank,
        score: item.score,
        verdict: item.verdict,
        reasoning: item.reasoning,
        run_id: item.run_id,
        ranked_at: created_at,
      },
    ]),
  );
}

/** Ofertas listas para responder: métricas, último veredicto de IA y favorito. */
export async function serializeOffers(
  db: Db,
  list: OfferWithRelations[],
  userId: string | null,
  config?: ScoringConfig,
): Promise<OfferRead[]> {
  if (!list.length) return [];
  const [metrics, ai, favorites] = await Promise.all([
    enrichOffers(db, list, config),
    latestAiSummaries(db, list),
    favoriteOfferIds(
      db,
      userId,
      list.map((offer) => offer.id),
    ),
  ]);
  return list.map((offer) =>
    offerRead(offer, metrics.get(offer.id)!, ai.get(offer.id) ?? null, favorites.has(offer.id)),
  );
}

