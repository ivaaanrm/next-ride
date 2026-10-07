/**
 * Puntuación de valor 0-100: algoritmo, configuración y desglose.
 *
 * La puntuación es la **media ponderada de subscores 0-100**, uno por
 * componente, renormalizada sobre los componentes con dato:
 *
 * - El rango es 0-100 de verdad, no un clamp de una suma que casi nunca llega.
 * - Faltar un dato reparte su peso, no congela puntos en la mitad de la escala.
 * - `sum(points)` del desglose **es** la puntuación: cada punto es rastreable.
 *
 * Casi todos los subscores son lineales con topes (50 neutro; la «escala
 * completa» dice qué desviación lo lleva al extremo). La potencia va en S.
 * Determinista: los mismos datos y la misma fecha dan la misma cifra.
 */

import { scoreConfig, type Offer, type VehicleCondition } from "../db/schema";
import type { Db } from "../lib/db";
import { median } from "../lib/stats";
import { owned } from "../lib/tenant";
import {
  DEFAULT_PARAMS,
  DEFAULT_WEIGHTS,
  ScoreParams,
  ScoreWeights,
  type ScoreBreakdownItem,
  type ScoreComponentInfo,
} from "../schemas/scoring";
import type { OfferMetrics, PriceStats } from "./metrics";

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Logística estable: la forma ingenua desborda con exponentes grandes. */
function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const exponential = Math.exp(z);
  return exponential / (1 + exponential);
}

/**
 * S de 0 a 100: plana en los extremos, empinada alrededor de `mid`. La
 * logística cruda no llega nunca a 0 ni a 100, así que se renormaliza sobre lo
 * que vale en los bordes de la ventana.
 */
export function sCurve(
  value: number,
  low: number,
  high: number,
  mid: number,
  steepness: number,
): number {
  const floor = sigmoid(steepness * (low - mid));
  const ceiling = sigmoid(steepness * (high - mid));
  const span = ceiling - floor;
  if (span <= 0) return clamp(((value - low) / (high - low)) * 100, 0, 100);
  const position = sigmoid(steepness * (clamp(value, low, high) - mid));
  return clamp(((position - floor) / span) * 100, 0, 100);
}

// --------------------------------------------------------------------------- //
// Configuración
// --------------------------------------------------------------------------- //
export interface ScoringConfig {
  weights: ScoreWeights;
  params: ScoreParams;
  updated_at: string | null;
}

export const DEFAULT_CONFIG: ScoringConfig = {
  weights: DEFAULT_WEIGHTS,
  params: DEFAULT_PARAMS,
  updated_at: null,
};

/**
 * Lo guardado, validado contra el esquema actual. Filtra claves que ya no
 * existan y cae a los defaults si el JSON no valida: una configuración corrupta
 * deja la app puntuando, no caída.
 */
function validated<T>(
  schema: typeof ScoreWeights | typeof ScoreParams,
  stored: Record<string, unknown>,
  fallback: T,
): T {
  const known = Object.fromEntries(
    Object.entries(stored ?? {}).filter(([key]) => key in schema.shape),
  );
  const result = schema.safeParse(known);
  if (!result.success) {
    console.warn(JSON.stringify({ message: "score config inválida en BD; se usan defaults" }));
    return fallback;
  }
  return result.data as T;
}

/** Los pesos y parámetros de la cuenta: cada una puntúa con los suyos. */
export async function getScoringConfig(db: Db, tenantId: string): Promise<ScoringConfig> {
  const [row] = await db.select().from(scoreConfig).where(owned(scoreConfig, tenantId));
  if (!row) return DEFAULT_CONFIG;
  return {
    weights: validated(ScoreWeights, row.weights, DEFAULT_WEIGHTS),
    params: validated(ScoreParams, row.params, DEFAULT_PARAMS),
    updated_at: row.updated_at,
  };
}

/** Guarda lo que venga y conserva el resto. Crea la fila de la cuenta si no existe. */
export async function saveScoringConfig(
  db: Db,
  tenantId: string,
  weights: ScoreWeights | null | undefined,
  params: ScoreParams | null | undefined,
): Promise<ScoringConfig> {
  const current = await getScoringConfig(db, tenantId);
  const merged = { weights: weights ?? current.weights, params: params ?? current.params };
  const now = new Date().toISOString();
  await db
    .insert(scoreConfig)
    .values({ user_id: tenantId, ...merged, created_at: now, updated_at: now })
    .onConflictDoUpdate({
      target: scoreConfig.user_id,
      set: { ...merged, updated_at: now },
    });
  return getScoringConfig(db, tenantId);
}

// --------------------------------------------------------------------------- //
// Modelo de depreciación
// --------------------------------------------------------------------------- //
/** Fracción del PVP que conserva un coche usado de esa edad. */
export function residualFraction(ageYears: number, params: ScoreParams): number {
  const curve = params.residual_curve;
  const last = curve.length - 1;
  const value =
    ageYears <= last
      ? curve[Math.max(ageYears, 0)]
      : curve[last] * params.residual_late_decay ** (ageYears - last);
  return Math.max(value, params.residual_floor);
}

/** Un coche a estrenar no ha entrado aún en la curva; el resto sí. */
function residualFor(condition: VehicleCondition, ageYears: number, params: ScoreParams): number {
  return condition === "new" ? 1 : residualFraction(ageYears, params);
}

/**
 * PVP estimado del binomio: la curva de depreciación, invertida. Cada oferta
 * con año implica un precio de nuevo (`precio / residual(edad)`); la mediana de
 * esas implicaciones es el ancla cuando nadie ha curado `reference_price`.
 */
export function marketNewPrice(
  rows: Iterable<{ price: number; year: number | null; condition: VehicleCondition }>,
  params: ScoreParams,
  nowYear: number,
): number | null {
  const implied: number[] = [];
  for (const { price, year, condition } of rows) {
    if (price > 0 && year) {
      implied.push(price / residualFor(condition, Math.max(nowYear - year, 0), params));
    }
  }
  if (implied.length < params.min_market_comparables) return null;
  return round(median(implied)!, 2);
}

/**
 * Valor teórico hoy: el ancla de precio nuevo depreciada por edad y km. Sin
 * ancla o sin año no se estima nada: mejor un componente ausente que inventado.
 */
export function expectedPrice(
  offer: Pick<Offer, "year" | "condition" | "mileage_km">,
  anchor: number | null | undefined,
  params: ScoreParams,
  nowYear: number,
): number | null {
  if (!anchor || anchor <= 0 || !offer.year) return null;

  const age = Math.max(nowYear - offer.year, 0);
  let value = anchor * residualFor(offer.condition, age, params);

  if (offer.mileage_km !== null && offer.mileage_km !== undefined) {
    // Medio año de rodaje mínimo para que un coche del año no espere 0 km.
    const expectedKm = Math.max(age, 0.5) * params.expected_km_per_year;
    const excess = offer.mileage_km - expectedKm;
    const adjustment = clamp(
      ((-excess / 10000) * params.mileage_adjustment_per_10k_pct) / 100,
      -0.15,
      0.15,
    );
    value *= 1 + adjustment;
  }

  return round(value, 2);
}

// --------------------------------------------------------------------------- //
// Componentes
// --------------------------------------------------------------------------- //
/** (clave, etiqueta): el orden es el del desglose y el de la pantalla de Ajustes. */
export const COMPONENT_LABELS: [keyof ScoreWeights, string][] = [
  ["price_vs_market", "Precio vs mercado"],
  ["price_vs_expected", "Precio vs valor esperado"],
  ["mileage", "Kilometraje"],
  ["age", "Antigüedad"],
  ["power", "Potencia"],
  ["transmission", "Cambio"],
  ["equipment", "Equipamiento"],
  ["apparent_condition", "Estado aparente"],
  ["price_drop", "Bajada de precio"],
  ["freshness", "Frescura del anuncio"],
];

/** Las señales que no salen del anuncio: las pone una persona, de 1 a 5 estrellas. */
const MANUAL_RATINGS: [keyof ScoreWeights, "equipment_rating" | "apparent_condition_rating"][] = [
  ["equipment", "equipment_rating"],
  ["apparent_condition", "apparent_condition_rating"],
];

/** `f"{x:.0f}"` de Python. */
const fixed = (value: number, digits = 0) => value.toFixed(digits);

/** Explicaciones generadas de los propios parámetros: no pueden quedar viejas. */
export function componentDescriptions(params: ScoreParams): Record<string, string> {
  const kmYear = Math.round(params.expected_km_per_year)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const powerWindowMid = (params.power_zero_score_hp + params.power_full_score_hp) / 2;
  const powerWindowMidScore = sCurve(
    powerWindowMid,
    params.power_zero_score_hp,
    params.power_full_score_hp,
    params.power_mid_hp,
    params.power_curve_steepness,
  );
  return {
    price_vs_market:
      "Desviación del precio frente a la mediana de las ofertas activas del mismo " +
      `marca-modelo (mínimo ${params.min_market_comparables} comparables). ` +
      `Un ${fixed(params.market_full_scale_pct)} % por debajo de la mediana es un 100.`,
    price_vs_expected:
      "Precio frente al valor teórico del coche: un precio de nuevo —el PVP de la versión " +
      "o, si falta, el estimado del mercado invirtiendo la curva— depreciado por edad " +
      "según la curva media y ajustado por kilometraje " +
      `(±${fixed(params.mileage_adjustment_per_10k_pct, 1)} % por cada 10.000 km de desvío). ` +
      `Un ${fixed(params.expected_full_scale_pct)} % por debajo del valor esperado es un 100.`,
    mileage:
      `Kilómetros frente a los esperados por su edad (${kmYear} km/año). ` +
      "La mitad de lo esperado puntúa 75; el doble, 0.",
    age:
      "Más nuevo puntúa más alto, linealmente: un coche de este año es un 100 y uno de " +
      `${fixed(params.age_zero_score_years)} años un 0.`,
    power:
      `Más potencia puntúa más alto: ${fixed(params.power_zero_score_hp)} CV o menos es ` +
      `un 0 y ${fixed(params.power_full_score_hp)} CV o más un 100. Fuera de esa ventana ` +
      "la señal se agota: ni un utilitario pierde más por ser aún menos potente ni un " +
      "deportivo gana más por serlo aún más. Dentro va una curva en S: dura abajo, " +
      `empinada al pasar de ${fixed(params.power_mid_hp)} CV —el despegue, donde más sube ` +
      `por cada CV— y saturada arriba, así que ${fixed(powerWindowMid)} CV ya puntúan ` +
      `${fixed(powerWindowMidScore)}.`,
    transmission: "Cambio automático puntúa 100 y manual 0; otros tipos, 50.",
    equipment:
      "Nota manual del equipamiento que trae el coche, de 1 a 5 estrellas: " +
      "3 ★ es un 50 neutro, 5 ★ un 100 y 1 ★ un 0. No sale del anuncio, la pone " +
      "una persona en la ficha de la oferta; sin nota, su peso se reparte.",
    apparent_condition:
      "Nota manual del estado en que aparenta estar el coche —fotos, descripción, " +
      "lo que se vio al verlo—, de 1 a 5 estrellas: 3 ★ es un 50 neutro, 5 ★ un 100 " +
      "y 1 ★ un 0. Sin nota, su peso se reparte entre las demás señales.",
    price_drop:
      "Descenso del precio desde que la plataforma vio la oferta por primera vez. " +
      `Una bajada del ${fixed(params.price_drop_full_scale_pct)} % es un 100; sin cambios, 50.`,
    freshness:
      "Los anuncios recién publicados puntúan más alto: a los " +
      `${fixed(params.freshness_zero_score_days)} días la señal se agota y puntúa 0.`,
  };
}

/** Componentes con su peso vigente y el % que representa: para Ajustes. */
export function componentInfo(config: ScoringConfig): ScoreComponentInfo[] {
  const weights = config.weights;
  const descriptions = componentDescriptions(config.params);
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  return COMPONENT_LABELS.map(([key, label]) => ({
    key,
    label,
    description: descriptions[key],
    weight: weights[key],
    weight_pct: total > 0 ? round((weights[key] / total) * 100, 1) : 0,
    default_weight: DEFAULT_WEIGHTS[key],
  }));
}

interface Component {
  key: keyof ScoreWeights;
  metric: number | null;
  unit: string;
  subscore: number | null; // null = sin dato: su peso se reparte
  text?: string | null;
}

/** 50 en el centro; `fullScalePct` de desviación favorable llega a 100. */
const linear = (deviationPct: number, fullScalePct: number) =>
  clamp(50 + (deviationPct / fullScalePct) * 50, 0, 100);

type ScorableOffer = Pick<
  Offer,
  | "year"
  | "mileage_km"
  | "power_hp"
  | "transmission"
  | "condition"
  | "equipment_rating"
  | "apparent_condition_rating"
>;

function components(
  offer: ScorableOffer,
  stats: PriceStats | null | undefined,
  metrics: OfferMetrics,
  initialPrice: number | null | undefined,
  params: ScoreParams,
  nowYear: number,
): Component[] {
  const out: Component[] = [];

  // Precio contra la mediana del binomio. Con menos comparables que el mínimo
  // la mediana es poco más que el propio coche: mejor repartir el peso.
  const pvm = metrics.price_vs_median_pct;
  const hasMarket = pvm !== null && !!stats && stats.count >= params.min_market_comparables;
  out.push({
    key: "price_vs_market",
    metric: pvm,
    unit: "%",
    subscore: hasMarket ? linear(-pvm!, params.market_full_scale_pct) : null,
  });

  // Precio contra el valor esperado por depreciación.
  const pve = metrics.price_vs_expected_pct;
  out.push({
    key: "price_vs_expected",
    metric: pve,
    unit: "%",
    subscore: pve !== null ? linear(-pve, params.expected_full_scale_pct) : null,
  });

  // Kilometraje contra el esperado por edad (absoluto, no contra el cohorte).
  if (offer.mileage_km !== null && offer.year) {
    const age = Math.max(nowYear - offer.year, 0);
    const expectedKm = Math.max(age, 0.5) * params.expected_km_per_year;
    const kmDeviation = ((offer.mileage_km - expectedKm) / expectedKm) * 100;
    out.push({
      key: "mileage",
      metric: round(kmDeviation, 1),
      unit: "%",
      subscore: linear(-kmDeviation, params.mileage_full_scale_pct),
    });
  } else {
    out.push({ key: "mileage", metric: null, unit: "%", subscore: null });
  }

  // Antigüedad: preferencia por coche reciente, independiente del precio.
  if (offer.year) {
    const age = Math.max(nowYear - offer.year, 0);
    out.push({
      key: "age",
      metric: age,
      unit: "años",
      subscore: clamp(100 - (age / params.age_zero_score_years) * 100, 0, 100),
    });
  } else {
    out.push({ key: "age", metric: null, unit: "años", subscore: null });
  }

  // Potencia: S entre el CV que puntúa 0 y el que puntúa 100.
  if (offer.power_hp) {
    out.push({
      key: "power",
      metric: offer.power_hp,
      unit: "CV",
      subscore: sCurve(
        offer.power_hp,
        params.power_zero_score_hp,
        params.power_full_score_hp,
        params.power_mid_hp,
        params.power_curve_steepness,
      ),
    });
  } else {
    out.push({ key: "power", metric: null, unit: "CV", subscore: null });
  }

  // Cambio: automático mejor que manual; «otro» no dice nada y queda neutro.
  if (offer.transmission) {
    const [subscore, label] =
      offer.transmission === "automatic"
        ? [100, "Automático"]
        : offer.transmission === "manual"
          ? [0, "Manual"]
          : [50, "Otro"];
    out.push({ key: "transmission", metric: null, unit: "", subscore, text: label });
  } else {
    out.push({ key: "transmission", metric: null, unit: "", subscore: null });
  }

  // Las notas manuales: 1-5 estirado a 0-100 con el 3 ★ en el 50 neutro. Sin
  // nota el componente no existe —no puntúa 0—: un coche que nadie ha mirado no
  // puede perder puntos por no haberlo mirado.
  for (const [key, column] of MANUAL_RATINGS) {
    const rating = offer[column];
    out.push({
      key,
      metric: rating ?? null,
      unit: "★",
      subscore: rating !== null && rating !== undefined ? clamp(((rating - 1) / 4) * 100, 0, 100) : null,
    });
  }

  // Bajada de precio. Con primer precio conocido y sin cambios es un 50
  // legítimo (sabemos que no ha bajado); sin historial, no hay dato.
  if (initialPrice && initialPrice > 0) {
    const drop = metrics.price_drop_pct ?? 0;
    out.push({
      key: "price_drop",
      metric: drop,
      unit: "%",
      subscore: linear(drop, params.price_drop_full_scale_pct),
    });
  } else {
    out.push({ key: "price_drop", metric: null, unit: "%", subscore: null });
  }

  // Frescura: un buen precio recién publicado es el chollo que vuela.
  const days = metrics.days_listed;
  out.push({
    key: "freshness",
    metric: days,
    unit: "días",
    subscore: clamp(100 - (days / params.freshness_zero_score_days) * 100, 0, 100),
  });

  return out;
}

/**
 * La puntuación 0-100 y su desglose auditable: media ponderada de los subscores
 * disponibles, con los pesos renormalizados sobre lo que la oferta acredita.
 */
export function scoreOffer(
  offer: ScorableOffer,
  stats: PriceStats | null | undefined,
  metrics: OfferMetrics,
  initialPrice: number | null | undefined,
  config: ScoringConfig,
  now: Date = new Date(),
): [number | null, ScoreBreakdownItem[]] {
  const nowYear = now.getUTCFullYear();
  const weights = config.weights;
  const labels = Object.fromEntries(COMPONENT_LABELS);
  const parts = components(offer, stats, metrics, initialPrice, config.params, nowYear);

  const available = parts.filter((part) => part.subscore !== null);
  const totalWeight = available.reduce((sum, part) => sum + weights[part.key], 0);
  const score =
    totalWeight > 0
      ? round(
          available.reduce((sum, part) => sum + part.subscore! * weights[part.key], 0) /
            totalWeight,
          1,
        )
      : null;

  const breakdown = parts.map((part): ScoreBreakdownItem => {
    const ok = part.subscore !== null && totalWeight > 0;
    return {
      key: part.key,
      label: labels[part.key],
      available: part.subscore !== null,
      metric: part.subscore !== null ? part.metric : null,
      unit: part.unit,
      text: part.subscore !== null ? (part.text ?? null) : null,
      subscore: part.subscore !== null ? round(part.subscore, 1) : null,
      weight: weights[part.key],
      weight_pct: ok ? round((weights[part.key] / totalWeight) * 100, 1) : 0,
      points: ok ? round((part.subscore! * weights[part.key]) / totalWeight, 2) : null,
    };
  });
  return [score, breakdown];
}
