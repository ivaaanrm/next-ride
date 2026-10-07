/**
 * Modelos que el usuario decide seguir en la plataforma. Solo se siguen
 * versiones de la propia cuenta: un id de otra es un 404, como uno que no existe.
 */
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { router } from "../app";
import { carModels, trackedModels, type CarModel } from "../db/schema";
import { inList, runBatch, type Db } from "../lib/db";
import { notFound, parseBody, parseId, parseQuery, qBool, unprocessable } from "../lib/http";
import { owned, ownedRow } from "../lib/tenant";
import { requireUser } from "../middleware";
import { int, nullable, num } from "../schemas/common";
import { getOrCreateCarModel, makeModelKey } from "../services/catalog";
import { setModelSources, stopModelSources } from "../services/scrape-targets";
import { trackedModelRead } from "../services/serialize";

const Criteria = {
  target_price: nullable(num(z.number().min(0))),
  max_mileage_km: nullable(int(z.number().min(0))),
  min_year: nullable(int(z.number().min(1950).max(2100))),
  notes: nullable(z.string().max(1000)),
};

/**
 * Empieza a seguir un modelo: por `car_model_id` si ya existe, o por marca +
 * modelo (+ acabado) para crearlo en la misma llamada.
 */
const TrackedModelCreate = z
  .object({
    ...Criteria,
    car_model_id: nullable(int()),
    make: nullable(z.string().min(1).max(80)),
    model: nullable(z.string().min(1).max(120)),
    trim: z.string().max(120).default(""),
    // Solo se aplica si el modelo se crea aquí o no tenía PVP de referencia.
    reference_price: nullable(num(z.number().min(0))),
  })
  .refine((value) => value.car_model_id !== null || (value.make && value.model), {
    message: "Aporta 'car_model_id', o 'make' y 'model' para crear el modelo",
  });

/**
 * Varias versiones a la vez con los mismos criterios: es cómo se sigue un
 * binomio entero. El PVP no se toca aquí a propósito: es de la versión.
 */
const TrackedModelBulkCreate = z.object({ ...Criteria, car_model_ids: z.array(int()).min(1) });

const collapse = (value: string) => value.split(/\s+/).filter(Boolean).join(" ");

/**
 * Seguir un binomio marca-modelo en un solo paso: criterios y captación.
 *
 * `source_ids` dice en qué fuentes activas se busca; `null` deja la captación
 * como esté. Es lo que hace de «sigo el Toyota Corolla» una sola acción en vez
 * de tres pantallas: dar de alta el binomio en la matriz, esperar a que llegue
 * una oferta para que exista en el catálogo y volver a seguirlo.
 */
const GroupFollow = z.object({
  ...Criteria,
  make: z.string().min(1).max(80).transform(collapse),
  model: z.string().min(1).max(120).transform(collapse),
  source_ids: nullable(z.array(int(z.number().gt(0))).max(50)),
});

const GroupQuery = z.object({
  key: z.string().min(3).max(220),
  /** Además de dejar de seguirlo, que el scraper deje de buscarlo. */
  stop_scraping: qBool,
});

const TrackedModelUpdate = z
  .object({
    target_price: num(z.number().min(0)).nullable(),
    max_mileage_km: int(z.number().min(0)).nullable(),
    min_year: int(z.number().min(1950).max(2100)).nullable(),
    notes: z.string().max(1000).nullable(),
    is_active: z.boolean().nullable(),
  })
  .partial();

type CriteriaValues = {
  target_price: number | null;
  max_mileage_km: number | null;
  min_year: number | null;
  notes: string | null;
};

/** Re-seguir un modelo ya seguido actualiza los criterios en lugar de fallar. */
async function upsertTracking(db: Db, userId: string, carModelIds: number[], criteria: CriteriaValues) {
  const values = { ...criteria, is_active: true };
  await runBatch(
    db,
    carModelIds.map((carModelId) =>
      db
        .insert(trackedModels)
        .values({ user_id: userId, car_model_id: carModelId, ...values })
        .onConflictDoUpdate({
          target: [trackedModels.user_id, trackedModels.car_model_id],
          set: { ...values, updated_at: new Date().toISOString() },
        }),
    ),
  );
  return readTracked(db, userId, carModelIds);
}

/** Los seguimientos de la persona; su versión se sigue por la clave (`lib/tenant.ts`). */
async function readTracked(db: Db, userId: string, carModelIds?: number[]) {
  const rows = await db
    .select({ tracked: trackedModels, car_model: carModels })
    .from(trackedModels)
    .innerJoin(carModels, eq(carModels.id, trackedModels.car_model_id))
    .where(
      and(
        eq(trackedModels.user_id, userId),
        carModelIds ? inList(trackedModels.car_model_id, carModelIds) : undefined,
      ),
    )
    .orderBy(desc(trackedModels.created_at), desc(trackedModels.id));
  const byModel = new Map(rows.map((row) => [row.tracked.car_model_id, row]));
  const ordered = carModelIds ? carModelIds.flatMap((id) => byModel.get(id) ?? []) : rows;
  return ordered.map((row) => trackedModelRead(row.tracked, row.car_model));
}

export const trackingRoutes = router();
trackingRoutes.use(requireUser);

trackingRoutes.get("/", async (c) => c.json(await readTracked(c.var.db, c.var.user.id)));

trackingRoutes.post("/", async (c) => {
  const payload = await parseBody(c, TrackedModelCreate);
  const db = c.var.db;
  const tenantId = c.var.tenantId;
  const userId = c.var.user.id;

  let model: CarModel | undefined;
  if (payload.car_model_id !== null) {
    [model] = await db
      .select()
      .from(carModels)
      .where(ownedRow(carModels, tenantId, payload.car_model_id));
    if (!model) throw notFound("Modelo no encontrado");
  } else {
    model = await getOrCreateCarModel(db, tenantId, payload.make!, payload.model!, payload.trim);
  }

  if (payload.reference_price !== null && model.reference_price === null) {
    await db
      .update(carModels)
      .set({ reference_price: payload.reference_price })
      .where(ownedRow(carModels, tenantId, model.id));
  }

  const [tracked] = await upsertTracking(db, userId, [model.id], {
    target_price: payload.target_price,
    max_mileage_km: payload.max_mileage_km,
    min_year: payload.min_year,
    notes: payload.notes,
  });
  return c.json(tracked, 201);
});

// Las dos rutas `/bulk` van antes que las que llevan un id.
trackingRoutes.post("/bulk", async (c) => {
  const payload = await parseBody(c, TrackedModelBulkCreate);
  const db = c.var.db;
  const ids = [...new Set(payload.car_model_ids)];
  const found = new Set(
    (
      await db
        .select({ id: carModels.id })
        .from(carModels)
        .where(and(owned(carModels, c.var.tenantId), inList(carModels.id, ids)))
    ).map((row) => row.id),
  );
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) throw notFound(`Modelos no encontrados: ${missing.join(", ")}`);

  const tracked = await upsertTracking(db, c.var.user.id, ids, {
    target_price: payload.target_price,
    max_mileage_km: payload.max_mileage_km,
    min_year: payload.min_year,
    notes: payload.notes,
  });
  return c.json(tracked, 201);
});

/**
 * Deja de seguir varias versiones. Idempotente a propósito: se dispara sobre un
 * binomio entero, donde lo normal es que solo algunas tuvieran seguimiento.
 */
trackingRoutes.delete("/bulk", async (c) => {
  const ids = (c.req.query("car_model_ids") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => /^-?\d+$/.test(part))
    .map(Number);
  if (!ids.length) throw unprocessable("Aporta al menos un id de modelo en 'car_model_ids'");
  await c.var.db
    .delete(trackedModels)
    .where(and(eq(trackedModels.user_id, c.var.user.id), inList(trackedModels.car_model_id, ids)));
  return c.body(null, 204);
});

/**
 * Sigue el binomio entero —todas sus versiones— con unos criterios, y fija en
 * qué fuentes se busca.
 *
 * Si el catálogo todavía no tiene ninguna versión (nunca ha llegado una oferta
 * suya) se crea la base, sin acabado: así el modelo aparece ya en «Modelos»
 * como seguido, con cero ofertas, en vez de existir solo dentro de la matriz de
 * captación. Las versiones que traiga después la ingesta heredan el
 * seguimiento (`services/offers.ts`), porque seguir el binomio entero es
 * seguir también las que aún no se conocen.
 */
trackingRoutes.put("/group", async (c) => {
  const payload = await parseBody(c, GroupFollow);
  const db = c.var.db;
  const tenantId = c.var.tenantId;
  const key = makeModelKey(payload.make, payload.model);

  // La captación va primero porque es la que valida (una fuente inactiva da
  // 422): así un rechazo no deja ni la versión base ni los criterios a medias.
  const sourceIds =
    payload.source_ids === null
      ? null
      : await setModelSources(db, tenantId, payload.make, payload.model, payload.source_ids);

  let variants = await db
    .select({ id: carModels.id })
    .from(carModels)
    .where(
      and(
        owned(carModels, tenantId),
        eq(carModels.make_model_key, key),
        eq(carModels.is_active, true),
      ),
    );
  if (!variants.length) {
    variants = [await getOrCreateCarModel(db, tenantId, payload.make, payload.model)];
  }

  const ids = variants.map((variant) => variant.id);
  await upsertTracking(db, c.var.user.id, ids, {
    target_price: payload.target_price,
    max_mileage_km: payload.max_mileage_km,
    min_year: payload.min_year,
    notes: payload.notes,
  });

  return c.json({ key, tracked_variants: ids.length, source_ids: sourceIds });
});

/** Deja de seguir el binomio entero; con `stop_scraping`, también de buscarlo. */
trackingRoutes.delete("/group", async (c) => {
  const { key, stop_scraping } = parseQuery(c, GroupQuery);
  const db = c.var.db;
  const tenantId = c.var.tenantId;
  const variants = await db
    .select({ id: carModels.id })
    .from(carModels)
    .where(and(owned(carModels, tenantId), eq(carModels.make_model_key, key)));
  if (variants.length) {
    await db.delete(trackedModels).where(
      and(
        eq(trackedModels.user_id, c.var.user.id),
        inList(
          trackedModels.car_model_id,
          variants.map((variant) => variant.id),
        ),
      ),
    );
  }
  if (stop_scraping) await stopModelSources(db, tenantId, key);
  return c.body(null, 204);
});

trackingRoutes.patch("/:id", async (c) => {
  const id = parseId(c, "id");
  const payload = await parseBody(c, TrackedModelUpdate);
  const db = c.var.db;
  const [tracked] = await db.select().from(trackedModels).where(eq(trackedModels.id, id));
  if (!tracked || tracked.user_id !== c.var.user.id) throw notFound("Seguimiento no encontrado");
  const { is_active: isActive, ...rest } = payload;
  const set = { ...rest, ...(isActive !== undefined && isActive !== null ? { is_active: isActive } : {}) };
  if (Object.keys(set).length) {
    await db.update(trackedModels).set(set).where(eq(trackedModels.id, id));
  }
  const [result] = await readTracked(db, c.var.user.id, [tracked.car_model_id]);
  return c.json(result);
});

/** Se identifica por `car_model_id`, no por el id del seguimiento. */
trackingRoutes.delete("/:carModelId", async (c) => {
  const [deleted] = await c.var.db
    .delete(trackedModels)
    .where(
      and(
        eq(trackedModels.user_id, c.var.user.id),
        eq(trackedModels.car_model_id, parseId(c, "carModelId")),
      ),
    )
    .returning({ id: trackedModels.id });
  if (!deleted) throw notFound("Seguimiento no encontrado");
  return c.body(null, 204);
});
