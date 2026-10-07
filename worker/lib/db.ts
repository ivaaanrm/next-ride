import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

import { schema } from "../db/schema";

export type Db = DrizzleD1Database<typeof schema>;

export function getDb(env: Env): Db {
  return drizzle(env.DB, { schema });
}

/**
 * `columna IN (…)` con un único parámetro.
 *
 * D1 admite como mucho 100 parámetros por sentencia, y un `IN` con un parámetro
 * por id rompe en cuanto una página trae más ofertas. `json_each` desenrolla
 * el array dentro de SQLite: da igual que sean 3 ids o 3.000.
 */
export function inList(column: SQLWrapper, values: Iterable<number | string>): SQL {
  return sql`${column} IN (SELECT value FROM json_each(${JSON.stringify([...values])}))`;
}

/** Redondeo decimal (el `round(x, n)` de Python, salvo el desempate al par). */
export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function roundOrNull(value: number | null | undefined, digits = 2): number | null {
  return value === null || value === undefined || Number.isNaN(value) ? null : round(value, digits);
}

/** Importes a céntimos: las columnas de precio son REAL y no NUMERIC(12,2). */
export const toCents = (value: number) => round(value, 2);

/**
 * `db.batch()` con una lista de longitud variable. D1 ejecuta el lote como una
 * transacción: o entran todas las sentencias o ninguna.
 */
export async function runBatch(db: Db, statements: BatchItem<"sqlite">[]): Promise<void> {
  if (!statements.length) return;
  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}
