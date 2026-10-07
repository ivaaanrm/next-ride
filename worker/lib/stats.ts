/**
 * Las funciones de agregado de Postgres que SQLite no tiene, en TypeScript.
 *
 * Se calculan sobre las filas que devuelve D1. Para el tamaño de este catálogo
 * (cientos o pocos miles de ofertas activas) es más barato que cualquier truco
 * en SQL, y es la misma cuenta en todas partes.
 */

/** `percentile_cont(fraction) WITHIN GROUP (ORDER BY …)`: interpolación lineal. */
export function percentileCont(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = fraction * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export const median = (values: number[]) => percentileCont(values, 0.5);

/**
 * `mode() WITHIN GROUP (ORDER BY …)`: el valor más frecuente. Con empate gana el
 * primero en orden, que es lo que hace Postgres.
 */
export function mode(values: string[]): string | null {
  if (values.length === 0) return null;
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const [value, count] of [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/** `AVG()` ignorando nulos, como SQL. Sin valores, `null`. */
export function average(values: (number | null | undefined)[]): number | null {
  const present = values.filter((value): value is number => value !== null && value !== undefined);
  if (present.length === 0) return null;
  return present.reduce((sum, value) => sum + value, 0) / present.length;
}

export function minOf(values: (number | null | undefined)[]): number | null {
  const present = values.filter((value): value is number => value !== null && value !== undefined);
  return present.length ? Math.min(...present) : null;
}

export function maxOf(values: (number | null | undefined)[]): number | null {
  const present = values.filter((value): value is number => value !== null && value !== undefined);
  return present.length ? Math.max(...present) : null;
}
