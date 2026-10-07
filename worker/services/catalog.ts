/** Slugs, clave del binomio y alta (get-or-create) de dealers y versiones. */
import { and, eq } from "drizzle-orm";

import { carModels, type CarModel } from "../db/schema";
import type { Db } from "../lib/db";

export function slugify(...parts: (string | null | undefined)[]): string {
  const text = parts.filter(Boolean).join(" ");
  const normalized = text.normalize("NFKD").replace(/[^\x00-\x7f]/g, "");
  const slug = normalized
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return slug || "sin-nombre";
}

/**
 * `marca|modelo` en minúsculas: la clave del binomio.
 *
 * Se calcula aquí y en ningún otro sitio, y se persiste en
 * `car_models.make_model_key`. Antes la calculaba Postgres con `lower()`, y la
 * regla era la misma: dos minúsculas distintas dejarían a un binomio sin sus
 * agregados o sin sus ofertas. En SQLite, además, `lower()` solo pliega ASCII.
 */
export function makeModelKey(make: string, model: string): string {
  return `${make.toLowerCase()}|${model.toLowerCase()}`;
}

/** La versión por marca/modelo/acabado de la cuenta; se crea si no existe. */
export async function getOrCreateCarModel(
  db: Db,
  userId: string,
  make: string,
  model: string,
  trim = "",
): Promise<CarModel> {
  const slug = slugify(make, model, trim);
  const bySlug = and(eq(carModels.user_id, userId), eq(carModels.slug, slug));
  const [existing] = await db.select().from(carModels).where(bySlug);
  if (existing) return existing;

  const values = { slug, make: make.trim(), model: model.trim(), trim: trim.trim() };
  const [created] = await db
    .insert(carModels)
    .values({ ...values, user_id: userId, make_model_key: makeModelKey(values.make, values.model) })
    .onConflictDoNothing()
    .returning();
  // Una carrera con otra petición que la acaba de crear: se lee la suya.
  return created ?? (await db.select().from(carModels).where(bySlug))[0];
}
