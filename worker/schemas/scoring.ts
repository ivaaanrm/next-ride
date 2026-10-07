/**
 * Configuración y desglose de la puntuación de valor.
 *
 * La puntuación es una media ponderada de componentes 0-100. Estos esquemas son
 * el contrato con el frontend: los pesos que se editan en Ajustes, los
 * parámetros del modelo de depreciación y el desglose por oferta.
 */
import { z } from "zod";

const weight = (value: number) => z.number().min(0).max(100).default(value);

/**
 * Peso relativo de cada componente. No tienen que sumar 100: el peso final se
 * renormaliza sobre los componentes con dato. Los ocho automáticos suman 100
 * por defecto; las dos notas manuales añaden 5 cada una **por encima**, a
 * propósito: así no se mueve la puntuación de nadie hasta que alguien valore un
 * coche.
 */
export const ScoreWeights = z
  .strictObject({
    price_vs_market: weight(30),
    price_vs_expected: weight(25),
    mileage: weight(15),
    age: weight(10),
    power: weight(5),
    transmission: weight(5),
    equipment: weight(5),
    apparent_condition: weight(5),
    price_drop: weight(5),
    freshness: weight(5),
  })
  .refine((weights) => Object.values(weights).some((value) => value > 0), {
    message: "Al menos un peso debe ser mayor que cero",
  });
export type ScoreWeights = z.output<typeof ScoreWeights>;

/**
 * Constantes del modelo. `residual_curve[n]` es la fracción del PVP que conserva
 * un coche de `n` años (depreciación media del mercado español); pasado el
 * último punto se aplica `residual_late_decay` anual con el suelo `residual_floor`.
 */
export const ScoreParams = z
  .strictObject({
    expected_km_per_year: z.number().gt(0).max(100000).default(15000),
    residual_curve: z
      .array(z.number())
      .min(2)
      .max(30)
      .default([0.93, 0.8, 0.7, 0.62, 0.55, 0.49, 0.44, 0.4, 0.36, 0.33, 0.3])
      .refine((curve) => curve.every((value) => value > 0 && value <= 1), {
        message: "Cada punto de la curva debe estar en (0, 1]",
      })
      .refine((curve) => curve.every((value, i) => i === 0 || value <= curve[i - 1]), {
        message: "La curva residual no puede crecer con la edad",
      }),
    residual_late_decay: z.number().gt(0.5).lt(1).default(0.93),
    residual_floor: z.number().gt(0).lt(0.5).default(0.08),
    // Cada 10.000 km por encima (o debajo) de lo esperado mueve el valor
    // esperado este porcentaje. Acotado en `expectedPrice` a ±15 %.
    mileage_adjustment_per_10k_pct: z.number().min(0).max(10).default(1.5),
    // «Escala completa»: desviación que lleva el subscore de 50 al extremo.
    market_full_scale_pct: z.number().gt(0).max(100).default(25),
    expected_full_scale_pct: z.number().gt(0).max(100).default(40),
    mileage_full_scale_pct: z.number().gt(0).max(300).default(100),
    price_drop_full_scale_pct: z.number().gt(0).max(100).default(10),
    age_zero_score_years: z.number().gt(1).max(40).default(15),
    freshness_zero_score_days: z.number().gt(0).max(365).default(60),
    min_market_comparables: z.number().int().min(2).max(50).default(3),
    // Potencia: curva en S entre el CV que puntúa 0 y el que puntúa 100, con el
    // despegue en `power_mid_hp`. Una potencia de la posición (`t**γ`) no puede
    // hundir el suelo y levantar el centro a la vez; la S sí.
    power_zero_score_hp: z.number().min(0).max(500).default(100),
    power_full_score_hp: z.number().gt(0).max(1000).default(200),
    power_mid_hp: z.number().min(0).max(1000).default(135),
    power_curve_steepness: z.number().min(0.01).max(0.5).default(0.07),
  })
  .superRefine((params, ctx) => {
    if (params.power_full_score_hp <= params.power_zero_score_hp) {
      ctx.addIssue({
        code: "custom",
        message: "power_full_score_hp debe ser mayor que power_zero_score_hp",
      });
    } else if (
      !(
        params.power_zero_score_hp < params.power_mid_hp &&
        params.power_mid_hp < params.power_full_score_hp
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message: "power_mid_hp debe estar entre power_zero_score_hp y power_full_score_hp",
      });
    }
  });
export type ScoreParams = z.output<typeof ScoreParams>;

export const DEFAULT_WEIGHTS: ScoreWeights = ScoreWeights.parse({});
export const DEFAULT_PARAMS: ScoreParams = ScoreParams.parse({});

/** PUT parcial: lo que no venga se conserva. */
export const ScoreConfigUpdate = z.strictObject({
  weights: ScoreWeights.nullish(),
  params: ScoreParams.nullish(),
});

export interface ScoreComponentInfo {
  key: string;
  label: string;
  description: string;
  weight: number;
  weight_pct: number;
  default_weight: number;
}

/**
 * La aportación de un componente a la puntuación de una oferta: `sum(points)`
 * es la puntuación final. Un componente sin dato viaja con `available=false` y
 * peso 0, para que el frontend pueda decir *qué* faltó.
 */
export interface ScoreBreakdownItem {
  key: string;
  label: string;
  available: boolean;
  metric: number | null;
  unit: string;
  text: string | null;
  subscore: number | null;
  weight: number;
  weight_pct: number;
  points: number | null;
}
