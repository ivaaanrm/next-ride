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
  // El ranking de IA no está aquí: es del binomio, no de la versión.
}

/**
 * Un binomio marca-modelo con sus versiones colgando: la unidad del catálogo.
 *
 * `car_models` está partido por acabado —un «Audi A3» son veintitrés filas— y a
 * ese nivel casi cada fila tiene una sola oferta, con mínimo, mediana y máximo
 * iguales. Los precios de aquí son del binomio entero, calculados en el servidor
 * sobre todas sus ofertas: no salen de componer los de cada versión.
 */
export interface CarModelGroup {
  key: string;
  make: string;
  model: string;
  label: string;
  variants: CarModelWithStats[];
  variant_count: number;

  active_offers: number;
  min_price: number | null;
  median_price: number | null;
  max_price: number | null;
  dealers_count: number;

  /** Mediana de los PVP puestos, y sobre cuántas versiones. El PVP es de la versión. */
  reference_price: number | null;
  reference_variants: number;

  tracked_variants: number;
  /** El objetivo más bajo entre las versiones seguidas. */
  target_price: number | null;
  last_ranked_at: string | null;
}

export type ScrapeAccess = "fetch" | "playwright" | "browser" | "manual";

/** Fuente operativa del scraper; no es el vendedor que figura en una oferta. */
export interface ScrapeSource {
  id: number;
  key: string;
  name: string;
  base_url: string;
  search_url_template: string | null;
  listing_url: string | null;
  access: ScrapeAccess;
  notes: string | null;
  config: Record<string, unknown>;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ScrapeTarget {
  id: number;
  source_id: number;
  make_model_key: string;
  make: string;
  model: string;
  max_results: number;
  search_url: string | null;
  search_params: Record<string, unknown>;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  source: ScrapeSource;
}

export interface ScrapeTargetSelection {
  source_id: number;
  make: string;
  model: string;
}

/** Aportación de un componente al score. `sum(points)` es la puntuación. */
export interface ScoreBreakdownItem {
  key: string;
  label: string;
  available: boolean;
  metric: number | null;
  unit: string;
  /** Señales categóricas (cambio automático/manual): sustituye al número. */
  text: string | null;
  subscore: number | null;
  weight: number;
  weight_pct: number;
  points: number | null;
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

export interface ScoreComponentInfo {
  key: string;
  label: string;
  description: string;
  weight: number;
  weight_pct: number;
  default_weight: number;
}

export type ScoreWeights = Record<string, number>;

export interface ScoreParams {
  expected_km_per_year: number;
  residual_curve: number[];
  residual_late_decay: number;
  residual_floor: number;
  mileage_adjustment_per_10k_pct: number;
  market_full_scale_pct: number;
  expected_full_scale_pct: number;
  mileage_full_scale_pct: number;
  price_drop_full_scale_pct: number;
  age_zero_score_years: number;
  freshness_zero_score_days: number;
  min_market_comparables: number;
  power_zero_score_hp: number;
  power_full_score_hp: number;
  power_mid_hp: number;
  power_curve_steepness: number;
}

export interface ScoreConfig {
  weights: ScoreWeights;
  params: ScoreParams;
  components: ScoreComponentInfo[];
  default_weights: ScoreWeights;
  default_params: ScoreParams;
  updated_at: string | null;
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
  /**
   * Campos corregidos a mano. El scraper ya no los escribe: son los que ganó la
   * persona. Se enseñan marcados en el editor porque un dato escrito a mano y
   * uno traído del anuncio no valen lo mismo cuando algo no cuadra.
   */
  manual_fields: OfferEditableField[];
  edited_at: string | null;
  /**
   * Las dos notas que no salen de ningún anuncio: cuánto equipamiento trae y qué
   * pinta tiene. De 1 a 5, o `null` mientras nadie las haya puesto — y `null` no
   * es un 1: sin nota la señal no puntúa y su peso se reparte entre las demás.
   */
  equipment_rating: number | null;
  apparent_condition_rating: number | null;
}

/** Las notas que acepta `PUT /offers/{id}/rating`. */
export type OfferRatingField = "equipment_rating" | "apparent_condition_rating";

/** Las columnas que `PATCH /offers/{id}` deja escribir. Espejo de `EDITABLE_FIELDS`. */
export type OfferEditableField =
  | "title"
  | "price"
  | "original_price"
  | "currency"
  | "year"
  | "mileage_km"
  | "power_hp"
  | "condition"
  | "fuel_type"
  | "transmission"
  | "location"
  | "image_url"
  | "car_model_id"
  | "dealer_id";

/** Payload crudo del scraper. Se pide aparte, no viene en el listado. */
export interface OfferRaw {
  raw: Record<string, unknown> | null;
}

export interface OfferPricePoint {
  price: number;
  recorded_at: string;
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
  /** El run es del binomio marca-modelo (`marca|modelo` en minúsculas). */
  make_model_key: string;
  /** La grafía con la que se lanzó («Audi A3»), congelada en el run. */
  label: string;
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

/**
 * Agregados sobre el conjunto filtrado. Comparte los filtros de `GET /offers`,
 * así que describe exactamente las filas que se están viendo.
 */
export interface OfferAggregateStats {
  count: number;
  car_models: number;
  avg_price: number | null;
  avg_mileage_km: number | null;
  avg_km_per_year: number | null;
  avg_discount_pct: number | null;
  best_deal: Offer | null;
  ai_enabled: boolean;
  /**
   * Extremos del conjunto para los deslizadores, cada uno **sin** aplicar su
   * propio filtro (`min_price`/`max_price`, `min_year`/`max_year`). Son el
   * dominio del control, no un agregado de lo que se ve: si el filtro contara,
   * el carril se encogería a la propia selección en cada arrastre. Los demás
   * filtros sí cuentan, incluido el del otro rango.
   */
  price_floor: number | null;
  price_ceiling: number | null;
  year_floor: number | null;
  year_ceiling: number | null;
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

/* ---------------------------------------------------------------------------
 * Analítica. La unidad es el binomio marca-modelo, no `car_models`: el catálogo
 * se fragmenta por acabado y comparar a ese nivel no responde nada.
 * ------------------------------------------------------------------------- */

/** Una oferta reducida a lo que dibujan los gráficos. */
export interface SegmentPoint {
  id: number;
  price: number;
  mileage_km: number | null;
  year: number | null;
  km_per_year: number | null;
  value_score: number | null;
  discount_pct: number | null;
  dealer: string;
  trim: string;
  title: string;
}

export interface YearPoint {
  year: number;
  offers: number;
  median_price: number;
}

export interface DealerPoint {
  dealer_id: number;
  dealer: string;
  offers: number;
  median_price: number;
  min_price: number;
}

export interface MixSlice {
  key: string;
  offers: number;
}

export interface SegmentMix {
  fuel: MixSlice[];
  transmission: MixSlice[];
  condition: MixSlice[];
}

/**
 * Regresión precio ~ km del binomio. `price_per_10k_km` es lo que el mercado
 * cobra por cada 10.000 km menos; `r2` viaja con ella porque con pocas ofertas
 * la pendiente puede ser ruido, y una pendiente sin su ajuste aparenta saber algo.
 */
export interface PriceTrend {
  slope: number;
  intercept: number;
  r2: number;
  n: number;
  price_per_10k_km: number;
}

export interface Segment {
  key: string;
  make: string;
  model: string;
  label: string;

  offers: number;
  dealers: number;
  trims: number;

  min_price: number | null;
  p25_price: number | null;
  median_price: number | null;
  p75_price: number | null;
  max_price: number | null;
  avg_price: number | null;
  avg_mileage_km: number | null;
  avg_year: number | null;
  avg_km_per_year: number | null;
  avg_discount_pct: number | null;

  /** Lo que sigue solo viene en los binomios seleccionados. */
  detailed: boolean;
  offers_sampled: number;
  avg_value_score: number | null;
  trend: PriceTrend | null;
  by_year: YearPoint[];
  by_dealer: DealerPoint[];
  mix: SegmentMix;
  points: SegmentPoint[];
}

export interface AnalyticsSegments {
  segments: Segment[];
  detail_keys: string[];
  offers: number;
  /** Tope de binomios comparables: son las ranuras de color de la paleta. */
  max_detail: number;
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
