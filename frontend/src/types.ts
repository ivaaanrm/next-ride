export type OfferStatus = "active" | "dismissed" | "expired";
export type VehicleCondition = "new" | "km0" | "used" | "demo";
export type FuelType =
  | "petrol"
  | "diesel"
  | "hybrid"
  | "plugin_hybrid"
  | "electric"
  | "lpg"
  | "other";
export type Transmission = "manual" | "automatic" | "other";
export type Verdict = "excellent" | "good" | "fair" | "poor" | "avoid";
export type RunStatus = "pending" | "running" | "completed" | "failed";

export interface User {
  id: number;
  email: string;
  full_name: string | null;
  is_active: boolean;
  is_superuser: boolean;
  created_at: string;
  last_login_at: string | null;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

export interface Dealer {
  id: number;
  slug: string;
  name: string;
  website: string | null;
  city: string | null;
  country: string | null;
  rating: number | null;
  is_active: boolean;
  notes: string | null;
  created_at: string;
}

export interface DealerWithStats extends Dealer {
  active_offers: number;
  avg_discount_pct: number | null;
  best_price: number | null;
}

export interface CarModel {
  id: number;
  slug: string;
  make: string;
  model: string;
  trim: string;
  body_type: string | null;
  reference_price: number | null;
  is_active: boolean;
  display_name: string;
}

/** Criterios de seguimiento del usuario actual sobre un modelo. */
export interface TrackedModelPrefs {
  id: number;
  target_price: number | null;
  max_mileage_km: number | null;
  min_year: number | null;
  notes: string | null;
}

export interface CarModelWithStats extends CarModel {
  active_offers: number;
  min_price: number | null;
  median_price: number | null;
  max_price: number | null;
  dealers_count: number;
  is_tracked: boolean;
  tracking: TrackedModelPrefs | null;
  last_ranked_at: string | null;
}

export interface OfferMetrics {
  discount_pct: number | null;
  price_vs_median_pct: number | null;
  price_vs_reference_pct: number | null;
  price_drop_pct: number | null;
  days_listed: number;
  km_per_year: number | null;
  value_score: number | null;
}

export interface OfferRankSummary {
  rank: number;
  score: number;
  verdict: Verdict;
  reasoning: string | null;
  run_id: number;
  ranked_at: string;
}

export interface Offer {
  id: number;
  url: string;
  external_id: string | null;
  source: string | null;
  title: string;
  price: number;
  original_price: number | null;
  currency: string;
  year: number | null;
  mileage_km: number | null;
  power_hp: number | null;
  condition: VehicleCondition;
  fuel_type: FuelType | null;
  transmission: Transmission | null;
  location: string | null;
  image_url: string | null;
  status: OfferStatus;
  first_seen_at: string;
  last_seen_at: string;
  dismissed_at: string | null;
  dismiss_reason: string | null;
  dealer: Dealer;
  car_model: CarModel;
  metrics: OfferMetrics;
  ai: OfferRankSummary | null;
  is_favorite: boolean;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface RankedOffer {
  id: number;
  offer_id: number;
  rank: number;
  score: number;
  verdict: Verdict;
  reasoning: string | null;
  pros: string[] | null;
  cons: string[] | null;
  offer: Offer | null;
}

export interface RankingRun {
  id: number;
  car_model_id: number;
  status: RunStatus;
  model_used: string | null;
  effort: string | null;
  offers_considered: number;
  iterations: number;
  input_tokens: number;
  output_tokens: number;
  summary: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface RankingRunDetail extends RankingRun {
  items: RankedOffer[];
  tool_trace: { tool: string; input: Record<string, unknown> }[] | null;
}

export interface OverviewStats {
  active_offers: number;
  dismissed_offers: number;
  favorite_offers: number;
  dealers: number;
  car_models: number;
  tracked_models: number;
  avg_discount_pct: number | null;
  best_deal: Offer | null;
  ai_enabled: boolean;
}

export interface ApiKey {
  id: number;
  name: string;
  prefix: string;
  is_active: boolean;
  created_at: string;
  last_used_at: string | null;
}

export interface ApiKeyCreated extends ApiKey {
  api_key: string;
}
