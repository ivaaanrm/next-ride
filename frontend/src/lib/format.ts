import type {
  FuelType,
  OfferStatus,
  Transmission,
  VehicleCondition,
  Verdict,
} from "../types";

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

/**
 * El combustible reducido a una marca, para la tabla.
 *
 * Son iniciales y no pictogramas porque son siete categorías y cuatro de ellas
 * —híbrido, híbrido enchufable, eléctrico, GLP— no tienen un dibujo que se
 * reconozca sin haberlo aprendido antes; una inicial se lee al primer intento.
 * El «+» del enchufable dice lo que lo separa del híbrido a secas: que además
 * se enchufa.
 *
 * La marca nunca va sola: la celda lleva el rótulo entero en el `title` y en su
 * etiqueta accesible, y el panel de detalle lo escribe sin abreviar.
 */
export const FUEL_MARKS: Record<FuelType, string> = {
  petrol: "G",
  diesel: "D",
  hybrid: "H",
  plugin_hybrid: "H+",
  electric: "E",
  lpg: "GLP",
  other: "·",
};

export const TRANSMISSION_LABELS: Record<Transmission, string> = {
  manual: "Manual",
  automatic: "Automático",
  other: "Otro",
};

/**
 * Los tres estados de una oferta en la plataforma, con todo lo que hay que decir
 * de cada uno en un solo sitio: la lista, el botón que lleva a él, el aviso de
 * después y el porqué.
 *
 * Están juntos porque describirlos por separado es como se acaba con un botón
 * que dice «Descartar» y un aviso que dice «Oferta eliminada». La tabla la leen
 * la fila, el panel de detalle, los avisos y el desplegable de vista.
 *
 * Lo que separa a los dos estados de salida es **de quién es la afirmación**:
 * «descartada» la firma quien mira —no me interesa—, y el scraper la respeta
 * aunque el anuncio siga vivo; «no disponible» la firma el anuncio —ya no
 * está—, y por eso el scraper puede revivirla si vuelve a encontrarlo. El
 * modelo lo llama `expired`; aquí no, porque lo que se ve al pulsar no es que
 * haya caducado un plazo, es que el coche ya no está.
 */
export interface OfferStatusInfo {
  /** Cómo se llama el estado: la vista, el chip del panel. */
  label: string;
  /** Cómo se llama *ir* a ese estado: el botón. */
  verb: string;
  /** Cómo se cuenta que ya se fue: el aviso de deshacer. Concuerda con «oferta». */
  done: string;
  /** Qué implica, para el `title` del botón. Es lo que separa los dos descartes. */
  hint: string;
}

export const OFFER_STATUS: Record<OfferStatus, OfferStatusInfo> = {
  active: {
    label: "Activas",
    verb: "Restaurar",
    done: "restaurada",
    hint: "Devolver la oferta a la lista activa",
  },
  dismissed: {
    label: "Descartadas",
    verb: "Descartar",
    done: "descartada",
    hint: "No me interesa. Sale de la lista y el scraper no la vuelve a traer",
  },
  expired: {
    label: "No disponibles",
    verb: "No disponible",
    done: "marcada como no disponible",
    hint: "El anuncio ya no está en el origen. Si el scraper vuelve a verlo, la oferta revive",
  },
};

/** El estado en singular, para el chip del panel de detalle. */
export const OFFER_STATUS_LABELS: Record<OfferStatus, string> = {
  active: "Activa",
  dismissed: "Descartada",
  expired: "No disponible",
};

/** Descartar es una decisión y se pinta como tal; expirar solo constata un hecho. */
export function offerStatusTone(status: OfferStatus): string {
  if (status === "dismissed") return "negative";
  if (status === "expired") return "warm";
  return "neutral";
}

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
