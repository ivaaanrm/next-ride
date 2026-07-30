import type { FuelType, Transmission, VehicleCondition, Verdict } from "../types";

const eur = new Intl.NumberFormat("es-ES", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});
const number = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 });

export const formatPrice = (value: number | null | undefined): string =>
  value === null || value === undefined ? "—" : eur.format(value);

export const formatNumber = (value: number | null | undefined): string =>
  value === null || value === undefined ? "—" : number.format(value);

export const formatKm = (value: number | null | undefined): string =>
  value === null || value === undefined ? "—" : `${number.format(value)} km`;

const percent = new Intl.NumberFormat("es-ES", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export function formatPct(value: number | null | undefined, withSign = false): string {
  if (value === null || value === undefined) return "—";
  const sign = withSign && value > 0 ? "+" : "";
  // Con la coma decimal española, como el resto de cifras: un «11.7 %» junto a
  // un «17.472 km» se lee como si el punto significase lo mismo en los dos.
  return `${sign}${percent.format(value)}%`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("es-ES", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("es-ES", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const CONDITION_LABELS: Record<VehicleCondition, string> = {
  new: "Nuevo",
  km0: "Km 0",
  used: "Usado",
  demo: "Demo",
};

export const FUEL_LABELS: Record<FuelType, string> = {
  petrol: "Gasolina",
  diesel: "Diésel",
  hybrid: "Híbrido",
  plugin_hybrid: "Híbrido enchufable",
  electric: "Eléctrico",
  lpg: "GLP",
  other: "Otro",
};

export const TRANSMISSION_LABELS: Record<Transmission, string> = {
  manual: "Manual",
  automatic: "Automático",
  other: "Otro",
};

export const VERDICT_LABELS: Record<Verdict, string> = {
  excellent: "Excelente",
  good: "Buena",
  fair: "Correcta",
  poor: "Floja",
  avoid: "Evitar",
};

/** Clase de color para la puntuación (0-100). */
export function scoreTone(score: number | null | undefined): string {
  if (score === null || score === undefined) return "neutral";
  if (score >= 75) return "positive";
  if (score >= 55) return "warm";
  if (score >= 35) return "neutral";
  return "negative";
}

export function verdictTone(verdict: Verdict): string {
  switch (verdict) {
    case "excellent":
      return "positive";
    case "good":
      return "warm";
    case "fair":
      return "neutral";
    default:
      return "negative";
  }
}
