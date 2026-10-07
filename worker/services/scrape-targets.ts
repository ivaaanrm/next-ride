/**
 * La captación de **un** binomio en una cuenta: en qué fuentes se busca.
 *
 * `PUT /scraping/targets` reemplaza la selección entera —la matriz de la
 * cuenta—, y eso obligaba a quien solo quería añadir el Toyota Corolla a mandar
 * las sesenta combinaciones del resto para no apagarlas. Esto toca únicamente
 * las filas del binomio: las de los demás no se leen ni se escriben, y las de
 * otras cuentas ni se ven.
 */
import { and, eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import { scrapeSources, scrapeTargets } from "../db/schema";
import { inList, runBatch, type Db } from "../lib/db";
import { unprocessable } from "../lib/http";
import { canonicalMakeModelKey, defaultSearchParams } from "./scraping-config";

/** Lo que pide cada combinación cuando el binomio entra nuevo en captación. */
const DEFAULT_MAX_RESULTS = 15;

/**
 * Deja el binomio buscándose exactamente en `sourceIds` entre las fuentes
 * activas. Las inactivas no se tocan: sus combinaciones se conservan para
 * cuando vuelvan, igual que hace el reemplazo global.
 *
 * Devuelve los ids de las fuentes en las que queda activo.
 */
export async function setModelSources(
  db: Db,
  userId: string,
  make: string,
  model: string,
  sourceIds: number[],
): Promise<number[]> {
  const key = canonicalMakeModelKey(make, model);
  const wanted = new Set(sourceIds);

  const sources = await db.select().from(scrapeSources).where(eq(scrapeSources.is_active, true));
  const active = new Map(sources.map((source) => [source.id, source]));
  const missing = [...wanted].filter((id) => !active.has(id)).sort((a, b) => a - b);
  if (missing.length) throw unprocessable(`Fuentes inexistentes o inactivas: ${missing.join(", ")}`);

  const [existing, limits] = await Promise.all([
    db
      .select()
      .from(scrapeTargets)
      .where(and(eq(scrapeTargets.user_id, userId), eq(scrapeTargets.make_model_key, key))),
    // El tope por combinación es uno por cuenta en la práctica (la matriz lo
    // pone igual a todas): un binomio nuevo hereda el que ya tienen los demás.
    db
      .select({ max: scrapeTargets.max_results })
      .from(scrapeTargets)
      .where(and(eq(scrapeTargets.user_id, userId), eq(scrapeTargets.is_active, true)))
      .limit(1),
  ]);
  const bySource = new Map(existing.map((target) => [target.source_id, target]));
  const maxResults = limits[0]?.max ?? DEFAULT_MAX_RESULTS;
  const now = new Date().toISOString();
  const statements: BatchItem<"sqlite">[] = [];

  for (const id of wanted) {
    const source = active.get(id)!;
    const current = bySource.get(id);
    const defaults = defaultSearchParams(source, make, model);
    if (!current) {
      statements.push(
        db.insert(scrapeTargets).values({
          user_id: userId,
          source_id: id,
          make_model_key: key,
          make,
          model,
          max_results: maxResults,
          search_params: defaults,
          is_active: true,
        }),
      );
    } else if (!current.is_active) {
      // Se reactiva con lo que el scraper ya había aprendido (ids, URL).
      statements.push(
        db
          .update(scrapeTargets)
          .set({
            is_active: true,
            search_params: { ...defaults, ...current.search_params },
            updated_at: now,
          })
          .where(eq(scrapeTargets.id, current.id)),
      );
    }
  }

  const off = existing
    .filter((target) => target.is_active && active.has(target.source_id) && !wanted.has(target.source_id))
    .map((target) => target.id);
  if (off.length) {
    statements.push(
      db
        .update(scrapeTargets)
        .set({ is_active: false, updated_at: now })
        .where(inList(scrapeTargets.id, off)),
    );
  }

  await runBatch(db, statements);
  return [...wanted].sort((a, b) => a - b);
}

/** Saca el binomio de la captación de la cuenta, sin borrar lo aprendido. */
export async function stopModelSources(db: Db, userId: string, key: string): Promise<void> {
  await db
    .update(scrapeTargets)
    .set({ is_active: false, updated_at: new Date().toISOString() })
    .where(
      and(
        eq(scrapeTargets.user_id, userId),
        eq(scrapeTargets.make_model_key, key),
        eq(scrapeTargets.is_active, true),
      ),
    );
}
