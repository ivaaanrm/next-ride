/**
 * Perfil radial: de una magnitud a un radio.
 *
 * Los dos radares de la app —una oferta contra sus comparables, y los binomios
 * marca-modelo entre sí— tienen que leerse igual, y eso solo se sostiene si la
 * regla vive en un sitio: **el centro de la escala es la mediana del conjunto de
 * referencia y el borde, la mayor desviación que hay en ese conjunto**. Fuera
 * del anillo central está lo que es mejor para quien compra; dentro, lo que es
 * peor. Un radar sin esa frase es un polígono bonito del que no se deduce nada.
 *
 * Que el borde sea la mayor desviación es lo que hace legible el gráfico, pero
 * solo eso mentiría: en un conjunto donde el precio varía un 2 %, estirar ese
 * 2 % hasta el borde pinta como abismo lo que es ruido. Por eso cada eje trae un
 * recorrido mínimo (`minSpan`): por debajo de él las series se quedan cerca del
 * centro, que es exactamente lo que son, todas parecidas.
 *
 * Y por eso el radio **no es una puntuación**. Un 100 en «Precio» no dice que la
 * oferta sea buena, dice que es la más barata de su conjunto; el mismo coche en
 * otro conjunto sale en otro sitio. Los valores crudos viajan con cada eje para
 * que el tooltip enseñe la cifra y no solo la posición.
 */

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

const isNumber = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value);

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export interface RadarAxis {
  label: string;
  /** Qué mide, en palabras. Va al tooltip: el rótulo del eje no cabe explicado. */
  hint?: string;
  /** `1` si más es mejor para quien compra; `-1` si lo es menos. */
  direction: 1 | -1;
  /**
   * Recorrido mínimo del eje, en sus propias unidades o en fracción de la
   * mediana si `relative`. Es el suelo que impide que una diferencia
   * insignificante llene el radio.
   */
  minSpan: number;
  relative?: boolean;
  format: (value: number) => string;
  /** El conjunto contra el que se normaliza; los nulos se descartan. */
  cohort: (number | null | undefined)[];
  /** El valor de cada serie, en el orden de `seriesKeys`. */
  values: (number | null | undefined)[];
}

export interface RadarCell {
  key: string;
  /** Posición en la escala, 0-100. No es una nota. */
  radius: number;
  /** El valor crudo ya escrito, que es lo que se enseña en el tooltip. */
  raw: string;
}

/**
 * Una fila por eje. Los radios van además sueltos bajo la clave de su serie
 * porque es lo que lee el `dataKey` de Recharts; `cells` es lo mismo ordenado
 * para el tooltip y para las lecturas en texto.
 */
export interface RadarRow {
  axis: string;
  hint: string | null;
  ref: number;
  refRaw: string;
  cells: RadarCell[];
  [key: string]: unknown;
}

/** Donde cae la mediana del conjunto: el anillo contra el que se lee todo. */
export const RADAR_MID = 50;

/** Por debajo de tres ejes no hay polígono que dibujar, solo una línea. */
export const RADAR_MIN_AXES = 3;

export function buildRadar(
  axes: RadarAxis[],
  seriesKeys: string[],
  { minCohort = 3 }: { minCohort?: number } = {},
): { rows: RadarRow[]; dropped: string[] } {
  const rows: RadarRow[] = [];
  const dropped: string[] = [];

  for (const axis of axes) {
    const cohort = axis.cohort.filter(isNumber);
    const reference = median(cohort);

    // Un eje solo compara si hay contra qué comparar y si **todas** las series
    // traen el dato. Rellenar el hueco con un valor neutro sería peor que
    // quitarlo: pintaría «del montón» donde lo que pasa es que no se sabe.
    if (
      reference === null ||
      cohort.length < minCohort ||
      axis.values.some((value) => !isNumber(value))
    ) {
      dropped.push(axis.label);
      continue;
    }

    // Todo el conjunto vale lo mismo: el eje no separa nada y ocuparía un radio
    // en el que las series se pisan en el centro aparentando que ahí hay algo.
    const reach = Math.max(...cohort.map((value) => Math.abs(value - reference)));
    if (reach === 0) {
      dropped.push(axis.label);
      continue;
    }

    const floor = axis.relative ? axis.minSpan * Math.abs(reference) : axis.minSpan;
    const span = Math.max(reach, floor) || 1;

    /** La mediana cae en el centro; una desviación de `span` llega al borde. */
    const radiusOf = (value: number): number => {
      const offset = (axis.direction * (value - reference) * RADAR_MID) / span;
      return Math.round(clamp(RADAR_MID + offset, 0, 100) * 10) / 10;
    };

    const cells = axis.values.map((value, index) => ({
      key: seriesKeys[index],
      radius: radiusOf(value as number),
      raw: axis.format(value as number),
    }));

    rows.push({
      axis: axis.label,
      hint: axis.hint ?? null,
      ref: RADAR_MID,
      refRaw: axis.format(reference),
      cells,
      ...Object.fromEntries(cells.map((cell) => [cell.key, cell.radius])),
    });
  }

  return { rows, dropped };
}

/** El eje donde una serie más se aleja del centro, hacia fuera o hacia dentro. */
export function extremeAxis(
  rows: RadarRow[],
  key: string,
  side: "best" | "worst",
): { axis: string; radius: number } | null {
  const cells = rows
    .map((row) => ({ axis: row.axis, radius: row.cells.find((cell) => cell.key === key)?.radius }))
    .filter((item): item is { axis: string; radius: number } => item.radius !== undefined);

  if (!cells.length) return null;
  return cells.reduce((pick, item) =>
    side === "best"
      ? item.radius > pick.radius
        ? item
        : pick
      : item.radius < pick.radius
        ? item
        : pick,
  );
}
