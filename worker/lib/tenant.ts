/**
 * Cuentas: cada fila del dominio es de una (`user_id`), y aquí es donde una
 * consulta lo dice. Tres reglas:
 *
 * 1. **Una petición trabaja dentro de una cuenta**: `c.var.tenantId`, que fijan
 *    las puertas de `middleware.ts` (la persona de la sesión, o la dueña de la
 *    API key). Un handler no la deduce por su cuenta de `c.var.user`.
 *
 * 2. **Se acota la raíz**: la tabla que la petición nombra —la oferta por id, el
 *    listado de dealers, las versiones de un binomio— se filtra con `owned()` o
 *    `ownedRow()`. Una fila de otra cuenta es un 404, igual que una que no
 *    existe.
 *
 * 3. **Lo demás se sigue por sus claves**: lo que se alcanza desde una fila
 *    acotada por una clave ajena (las ofertas de un dealer, la versión de una
 *    oferta) es de la misma cuenta, porque los disparadores de la migración 0003
 *    rechazan cualquier fila que apunte a otra. No hace falta repetir la cuenta
 *    en esas tablas.
 *
 * 4. **Un índice de cuenta solo abre la consulta.** D1 no tiene estadísticas,
 *    así que SQLite cree que `user_id = ?` es tan selectivo como `dealer_id = ?`
 *    y, en un empate, puede elegir el índice de la cuenta y recorrer todas sus
 *    ofertas **por cada fila** de una unión. Así leía `/dealers` 2,6 millones
 *    de filas (8 s) para 285 dealers. Por eso los índices de `offers` que
 *    empiezan por una clave llevan la cuenta detrás (`dealer_id, user_id,
 *    status, price`): con cuenta y clave en la consulta, el de la clave casa
 *    más columnas y gana. `test/query-plans.test.ts` pide el plan de cada
 *    consulta de las pantallas y falla si el índice de la cuenta aparece dentro
 *    de un bucle o se usa habiendo un filtro por clave.
 *
 * Las marcas personales (favoritos, seguimiento) son de la persona y se acotan
 * con `c.var.user.id`; hoy coinciden con la cuenta.
 */
import { and, eq, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

import type {
  apiKeys,
  carModels,
  dealers,
  offers,
  rankingRuns,
  scoreConfig,
  scrapeTargets,
} from "../db/schema";

/** Las tablas del dominio: las que tienen dueña. */
export type TenantTable =
  | typeof apiKeys
  | typeof carModels
  | typeof dealers
  | typeof offers
  | typeof rankingRuns
  | typeof scoreConfig
  | typeof scrapeTargets;

/** Las filas de `table` que son de la cuenta. */
export const owned = (table: TenantTable, tenantId: string): SQL =>
  eq(table.user_id as AnySQLiteColumn, tenantId);

/** La fila `id` de `table`, solo si es de la cuenta. */
export const ownedRow = (table: TenantTable, tenantId: string, id: number): SQL =>
  and(eq(table.id as AnySQLiteColumn, id), owned(table, tenantId))!;
