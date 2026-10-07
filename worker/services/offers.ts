/**
 * Ofertas: ingesta (upsert por URL), corrección manual y favoritos.
 *
 * Todo dentro de una cuenta: el lote entra en la de quien ingesta (la sesión o
 * la dueña de la API key), y cada sentencia lleva esa cuenta como parámetro
 * (?2). Dealers, versiones y URLs se resuelven solo contra los suyos: la misma
 * URL en dos cuentas son dos ofertas, cada una con su historial.
 *
 * La ingesta es por conjuntos y no oferta a oferta. D1 cuenta cada sentencia
 * —también las de un `batch()`— contra un tope por invocación, y el upsert
 * fila a fila de antes eran cinco o seis consultas por oferta. Aquí un lote,
 * sea de 1 o de 500 ofertas, son nueve sentencias en dos `batch()`:
 *
 *   1. dealers (upsert), versiones (alta), y lectura de dealers, versiones y
 *      ofertas existentes;
 *   2. altas de ofertas, actualizaciones, historial de precios e ids finales.
 *
 * La decisión de qué se escribe —los anclajes de `manual_fields`, qué cuenta
 * como cambio de precio, cuándo revive una oferta— se toma en TypeScript con
 * las filas existentes delante, con la misma semántica campo a campo que tenía
 * `upsert_offer`. SQL solo recibe las filas ya resueltas, en JSON, y las
 * desenrolla con `json_each` (un parámetro por sentencia: D1 admite 100).
 */
import { and, eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { z } from "zod";

import {
  nowIso,
  offerFavorites,
  offerPriceHistory,
  offers,
  type Offer,
  type OfferStatus,
} from "../db/schema";
import { inList, runBatch, toCents, type Db } from "../lib/db";
import {
  EDITABLE_FIELDS,
  OfferIngest,
  type IngestResult,
  type OfferUpdate,
} from "../schemas/offer";
import { makeModelKey, slugify } from "./catalog";
import { putRawBatch, rawRef } from "./raw-store";

/** Cuáles de estas ofertas ha marcado el usuario. Vacío si no pregunta una persona. */
export async function favoriteOfferIds(
  db: Db,
  userId: string | null | undefined,
  offerIds: number[],
): Promise<Set<number>> {
  if (!userId || !offerIds.length) return new Set();
  const rows = await db
    .select({ offer_id: offerFavorites.offer_id })
    .from(offerFavorites)
    .where(and(eq(offerFavorites.user_id, userId), inList(offerFavorites.offer_id, offerIds)));
  return new Set(rows.map((row) => row.offer_id));
}

/** Comprime un error de validación a una línea legible para `IngestResult.errors`. */
function summarize(error: z.ZodError): string {
  return error.issues
    .slice(0, 4)
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
}

// --------------------------------------------------------------------------- //
// Ingesta
// --------------------------------------------------------------------------- //
/** Las columnas que la ingesta escribe en `offers`, en el orden del SQL. */
const OFFER_COLUMNS = [
  "url",
  "external_id",
  "source",
  "dealer_id",
  "car_model_id",
  "title",
  "price",
  "original_price",
  "currency",
  "year",
  "mileage_km",
  "power_hp",
  "condition",
  "fuel_type",
  "transmission",
  "location",
  "image_url",
  "raw_ref",
  "status",
  "dismissed_at",
  "dismissed_by_id",
  "dismiss_reason",
  "first_seen_at",
  "last_seen_at",
  "updated_at",
] as const;
type OfferColumns = Pick<Offer, (typeof OFFER_COLUMNS)[number]>;
type ExistingOffer = OfferColumns & Pick<Offer, "id" | "manual_fields">;

const extract = (column: string) => `json_extract(j.value, '$.${column}')`;

const INSERT_OFFERS = `
  INSERT INTO offers (user_id, ${OFFER_COLUMNS.join(", ")}, created_at)
  SELECT ?2, ${OFFER_COLUMNS.map(extract).join(", ")}, ${extract("last_seen_at")}
  FROM json_each(?1) AS j WHERE true
  ON CONFLICT(user_id, url) DO NOTHING`;

// `previous_updated_at` es el de la fila cuando se leyó. Si alguien la ha tocado
// entre la lectura y esta escritura (un descarte, una corrección a mano), la
// fila no casa y se queda como la dejó esa persona: la escritura reemplaza la
// fila entera y, sin esta guarda, desharía el cambio en silencio. El scraper
// la volverá a ver en el siguiente pase.
const UPDATE_OFFERS = `
  UPDATE offers SET ${OFFER_COLUMNS.filter((column) => column !== "url" && column !== "first_seen_at")
    .map((column) => `${column} = j.${column}`)
    .join(", ")}
  FROM (SELECT ${["id", "previous_updated_at", ...OFFER_COLUMNS].map((column) => `${extract(column)} AS ${column}`).join(", ")}
        FROM json_each(?1) AS j) AS j
  WHERE offers.id = j.id AND offers.user_id = ?2 AND offers.updated_at = j.previous_updated_at`;

const INSERT_HISTORY = `
  INSERT INTO offer_price_history (offer_id, price, recorded_at)
  SELECT o.id, ${extract("price")}, ${extract("recorded_at")}
  FROM json_each(?1) AS j JOIN offers AS o ON o.user_id = ?2 AND o.url = ${extract("url")}
  ORDER BY j.key`;

const UPSERT_DEALERS = `
  INSERT INTO dealers (user_id, slug, name, website, city, country, created_at, updated_at)
  SELECT ?2, ${["slug", "name", "website", "city", "country"].map(extract).join(", ")}, ?3, ?3
  FROM json_each(?1) AS j WHERE true
  ON CONFLICT(user_id, slug) DO UPDATE SET
    -- Se completan huecos sin sobrescribir lo que ya se curó a mano.
    website = COALESCE(NULLIF(dealers.website, ''), excluded.website),
    city = COALESCE(NULLIF(dealers.city, ''), excluded.city),
    country = COALESCE(NULLIF(dealers.country, ''), excluded.country),
    updated_at = CASE
      WHEN (NULLIF(dealers.website, '') IS NULL AND excluded.website IS NOT NULL)
        OR (NULLIF(dealers.city, '') IS NULL AND excluded.city IS NOT NULL)
        OR (NULLIF(dealers.country, '') IS NULL AND excluded.country IS NOT NULL)
      THEN excluded.updated_at ELSE dealers.updated_at END`;

const INSERT_CAR_MODELS = `
  INSERT INTO car_models (user_id, slug, make, model, trim, make_model_key, created_at, updated_at)
  SELECT ?2, ${["slug", "make", "model", "trim", "make_model_key"].map(extract).join(", ")}, ?3, ?3
  FROM json_each(?1) AS j WHERE true
  ON CONFLICT DO NOTHING`;

/**
 * Las versiones que acaba de crear este lote heredan el seguimiento si la
 * cuenta sigue el binomio **entero**.
 *
 * Seguir el Audi A3 es seguir también el acabado que el scraper aún no había
 * visto: sin esto, la primera oferta de un A3 nuevo caía en una versión sin
 * seguimiento y no aparecía en «solo los que sigo» justo cuando era noticia.
 * Quien sigue solo algunas versiones las eligió a mano, y a esa elección no se
 * le añade nada. Los criterios son los del seguimiento tocado más
 * recientemente, que es lo que el formulario del binomio escribe en todas.
 *
 * Las versiones nuevas se reconocen por su `created_at`, que es el `now` del
 * lote (?3) y no lo comparte ninguna anterior de la cuenta.
 */
const INHERIT_TRACKING = `
  INSERT INTO tracked_models
    (user_id, car_model_id, target_price, max_mileage_km, min_year, notes, is_active, created_at, updated_at)
  SELECT ?2, cm.id, f.target_price, f.max_mileage_km, f.min_year, f.notes, 1, ?3, ?3
  FROM car_models AS cm
  JOIN (
    SELECT m.make_model_key AS key, t.target_price, t.max_mileage_km, t.min_year, t.notes,
      ROW_NUMBER() OVER (PARTITION BY m.make_model_key ORDER BY t.updated_at DESC, t.id DESC) AS rn,
      COUNT(*) OVER (PARTITION BY m.make_model_key) AS followed
    FROM tracked_models AS t JOIN car_models AS m ON m.id = t.car_model_id
    WHERE t.user_id = ?2 AND m.user_id = ?2 AND t.is_active = 1 AND m.is_active = 1 AND m.created_at <> ?3
  ) AS f ON f.key = cm.make_model_key AND f.rn = 1
  WHERE cm.user_id = ?2 AND cm.created_at = ?3
    AND f.followed = (
      SELECT COUNT(*) FROM car_models AS o
      WHERE o.user_id = ?2 AND o.make_model_key = cm.make_model_key AND o.is_active = 1 AND o.created_at <> ?3
    )
  ON CONFLICT DO NOTHING`;

/** Filas de la cuenta (?2) cuya `key` está en la lista (?1). */
const SELECT_BY = (table: string, columns: string, key: string) =>
  `SELECT ${columns} FROM ${table} WHERE user_id = ?2 AND ${key} IN (SELECT value FROM json_each(?1))`;

interface Resolved {
  index: number;
  payload: OfferIngest;
  dealerSlug: string;
  modelSlug: string;
}

/**
 * Ingesta en lote en la cuenta `ownerId`. Ni un fallo de validación ni uno de
 * BD tumban el lote: si un trozo falla al escribir, se reintenta en trozos
 * menores hasta aislar la oferta mala (lo que antes hacía un savepoint por
 * oferta).
 */
export async function ingestOffers(
  d1: D1Database,
  bucket: R2Bucket,
  ownerId: string,
  rawOffers: unknown[],
): Promise<IngestResult> {
  const result: IngestResult = { created: 0, updated: 0, skipped: 0, errors: [], offer_ids: [] };

  const valid: Resolved[] = [];
  rawOffers.forEach((raw, index) => {
    const parsed = OfferIngest.safeParse(raw);
    if (!parsed.success) {
      result.skipped += 1;
      const url = raw && typeof raw === "object" ? (raw as { url?: unknown }).url : null;
      result.errors.push(`[${index}] ${url || "sin url"}: ${summarize(parsed.error)}`);
      return;
    }
    const payload = parsed.data;
    valid.push({
      index,
      payload,
      dealerSlug: slugify(payload.dealer_name),
      modelSlug: slugify(payload.make, payload.model, payload.trim),
    });
  });
  if (!valid.length) return result;

  // Por trozos: cada `writeBatch` son nueve sentencias y un parámetro JSON que
  // no puede pasar de 2 MB. Si un trozo falla, se reparte en trozos menores y,
  // al final, oferta a oferta, para aislar la mala sin pasarse del tope de
  // sentencias por invocación (1.000): el peor caso de un lote de 500 son
  // unas 230.
  for (let i = 0; i < valid.length; i += CHUNK) {
    await writeWithFallback(d1, bucket, ownerId, valid.slice(i, i + CHUNK), [SUB_CHUNK, 1], result);
  }
  return result;
}

const CHUNK = 100;
const SUB_CHUNK = 10;

async function writeWithFallback(
  d1: D1Database,
  bucket: R2Bucket,
  ownerId: string,
  items: Resolved[],
  fallbackSizes: number[],
  result: IngestResult,
): Promise<void> {
  try {
    const written = await writeBatch(d1, bucket, ownerId, items);
    result.created += written.created;
    result.updated += written.updated;
    result.offer_ids.push(...written.offerIds);
  } catch (error) {
    const [size, ...rest] = fallbackSizes;
    if (items.length === 1 || size === undefined) {
      for (const { index, payload } of items) {
        result.skipped += 1;
        result.errors.push(`[${index}] ${payload.url}: ${errorMessage(error)}`);
        logSkipped(payload.url, error);
      }
      return;
    }
    for (let i = 0; i < items.length; i += size) {
      await writeWithFallback(d1, bucket, ownerId, items.slice(i, i + size), rest, result);
    }
  }
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

function logSkipped(url: string, error: unknown) {
  console.warn(
    JSON.stringify({ message: "oferta descartada en la ingesta", url, error: errorMessage(error) }),
  );
}

async function writeBatch(
  d1: D1Database,
  bucket: R2Bucket,
  ownerId: string,
  items: Resolved[],
): Promise<{ created: number; updated: number; offerIds: number[] }> {
  const now = nowIso();

  // ---- 1. Dealers y versiones; lectura de lo que ya existe ------------------ //
  // Por slug, la primera aparición pone el nombre y las siguientes completan
  // huecos: lo mismo que el get-or-create secuencial de antes.
  const dealersBySlug = new Map<string, Record<string, string | null>>();
  const modelsBySlug = new Map<string, Record<string, string>>();
  for (const { payload, dealerSlug, modelSlug } of items) {
    const dealer = dealersBySlug.get(dealerSlug);
    if (!dealer) {
      dealersBySlug.set(dealerSlug, {
        slug: dealerSlug,
        name: payload.dealer_name,
        website: payload.dealer_website,
        city: payload.dealer_city,
        country: payload.dealer_country ?? null,
      });
    } else {
      dealer.website ||= payload.dealer_website;
      dealer.city ||= payload.dealer_city;
      dealer.country ||= payload.dealer_country ?? null;
    }
    if (!modelsBySlug.has(modelSlug)) {
      const make = payload.make.trim();
      const model = payload.model.trim();
      modelsBySlug.set(modelSlug, {
        slug: modelSlug,
        make,
        model,
        trim: payload.trim.trim(),
        make_model_key: makeModelKey(make, model),
      });
    }
  }
  const urls = [...new Set(items.map((item) => item.payload.url))];

  // El crudo va a R2 antes de leer nada: así la lectura de las filas
  // existentes y su escritura quedan lo más juntas posible.
  const rawKey = await putRawBatch(
    bucket,
    items.map((item) => item.payload.raw),
  );

  const [, , , dealerRows, modelRows, existingRows] = await d1.batch([
    d1.prepare(UPSERT_DEALERS).bind(JSON.stringify([...dealersBySlug.values()]), ownerId, now),
    d1.prepare(INSERT_CAR_MODELS).bind(JSON.stringify([...modelsBySlug.values()]), ownerId, now),
    d1.prepare(INHERIT_TRACKING).bind(null, ownerId, now),
    d1
      .prepare(SELECT_BY("dealers", "id, slug", "slug"))
      .bind(JSON.stringify([...dealersBySlug.keys()]), ownerId),
    d1
      .prepare(SELECT_BY("car_models", "id, slug", "slug"))
      .bind(JSON.stringify([...modelsBySlug.keys()]), ownerId),
    d1
      .prepare(SELECT_BY("offers", `id, manual_fields, ${OFFER_COLUMNS.join(", ")}`, "url"))
      .bind(JSON.stringify(urls), ownerId),
  ]);

  const dealerIds = new Map(
    (dealerRows.results as { id: number; slug: string }[]).map((row) => [row.slug, row.id]),
  );
  const modelIds = new Map(
    (modelRows.results as { id: number; slug: string }[]).map((row) => [row.slug, row.id]),
  );

  // ---- 2. Resolver cada oferta contra lo que hay ---------------------------- //
  // `state` arranca con las filas existentes y se va actualizando, así que dos
  // apariciones de la misma URL en un lote se comportan como dos pases
  // seguidos del scraper: la primera crea, la segunda actualiza.
  const state = new Map<string, ExistingOffer | OfferColumns>();
  const previousUpdatedAt = new Map<string, string>();
  for (const row of existingRows.results as Record<string, unknown>[]) {
    previousUpdatedAt.set(row.url as string, row.updated_at as string);
    state.set(row.url as string, {
      ...(row as unknown as ExistingOffer),
      manual_fields: JSON.parse((row.manual_fields as string) || "[]"),
    });
  }
  const existingUrls = new Set(state.keys());
  const createdUrls = new Set<string>();
  const history: { url: string; price: number; recorded_at: string }[] = [];
  let created = 0;
  let updated = 0;

  items.forEach(({ index, payload, dealerSlug, modelSlug }, position) => {
    const dealerId = dealerIds.get(dealerSlug);
    const carModelId = modelIds.get(modelSlug);
    if (dealerId === undefined || carModelId === undefined) {
      throw new Error(`No se pudo resolver el dealer o la versión de la oferta ${index}`);
    }
    const price = toCents(payload.price);
    const ref = rawKey && payload.raw ? rawRef(rawKey, position) : null;
    // Marcas de tiempo crecientes dentro del lote: el «primer precio» de una
    // oferta es el de menor `recorded_at`, y no puede salir empatado.
    const recordedAt = new Date(Date.parse(now) + position).toISOString();
    const current = state.get(payload.url);

    if (!current) {
      state.set(payload.url, {
        url: payload.url,
        external_id: payload.external_id,
        source: payload.source,
        dealer_id: dealerId,
        car_model_id: carModelId,
        title: payload.title,
        price,
        original_price: payload.original_price === null ? null : toCents(payload.original_price),
        currency: payload.currency,
        year: payload.year,
        mileage_km: payload.mileage_km,
        power_hp: payload.power_hp,
        condition: payload.condition,
        fuel_type: payload.fuel_type,
        transmission: payload.transmission,
        location: payload.location,
        image_url: payload.image_url,
        raw_ref: ref,
        status: "active",
        dismissed_at: null,
        dismissed_by_id: null,
        dismiss_reason: null,
        first_seen_at: now,
        last_seen_at: now,
        updated_at: now,
      });
      createdUrls.add(payload.url);
      history.push({ url: payload.url, price, recorded_at: recordedAt });
      created += 1;
      return;
    }

    // Ya existía: se refrescan los datos y se anota el precio si cambió. Salvo
    // lo que haya corregido una persona: las columnas de `manual_fields` ganó
    // la mano y el scraper no vuelve a escribirlas. La procedencia y las fechas
    // de rastreo quedan siempre en manos del scraper.
    const pinned = new Set("manual_fields" in current ? current.manual_fields : []);
    const fresh = <K extends keyof OfferColumns>(field: K, value: OfferColumns[K]) =>
      pinned.has(field) ? current[field] : value;

    const next: OfferColumns = { ...current };
    if (!pinned.has("price")) {
      if (toCents(current.price) !== price) {
        history.push({ url: payload.url, price, recorded_at: recordedAt });
      }
      next.price = price;
    }
    next.title = fresh("title", payload.title);
    next.last_seen_at = now;
    next.updated_at = now;
    next.dealer_id = fresh("dealer_id", dealerId);
    next.car_model_id = fresh("car_model_id", carModelId);
    next.external_id = payload.external_id || current.external_id;
    next.source = payload.source || current.source;
    if (payload.original_price) {
      next.original_price = fresh("original_price", toCents(payload.original_price));
    }
    next.currency = fresh("currency", payload.currency);
    next.year = fresh("year", payload.year ?? current.year);
    next.mileage_km = fresh("mileage_km", payload.mileage_km ?? current.mileage_km);
    next.power_hp = fresh("power_hp", payload.power_hp ?? current.power_hp);
    next.condition = fresh("condition", payload.condition);
    next.fuel_type = fresh("fuel_type", payload.fuel_type || current.fuel_type);
    next.transmission = fresh("transmission", payload.transmission || current.transmission);
    next.location = fresh("location", payload.location || current.location);
    next.image_url = fresh("image_url", payload.image_url || current.image_url);
    if (ref) next.raw_ref = ref;
    // Una oferta descartada a mano NO se reactiva al volver a verla; una
    // expirada sí, y con ella se va la marca de quién la retiró y por qué: un
    // «la llamé y estaba vendida» no describe un anuncio que vuelve a estar.
    if (current.status === ("expired" satisfies OfferStatus)) {
      next.status = "active";
      next.dismissed_at = null;
      next.dismissed_by_id = null;
      next.dismiss_reason = null;
    }
    state.set(payload.url, "manual_fields" in current ? { ...next, id: current.id, manual_fields: current.manual_fields } : next);
    updated += 1;
  });

  // ---- 3. Escritura atómica ------------------------------------------------- //
  const toInsert = [...createdUrls].map((url) => state.get(url)!);
  const toUpdate = [...existingUrls].map((url) => ({
    ...(state.get(url) as ExistingOffer),
    previous_updated_at: previousUpdatedAt.get(url),
  }));
  const [, , , idRows] = await d1.batch([
    d1.prepare(INSERT_OFFERS).bind(JSON.stringify(toInsert), ownerId),
    d1.prepare(UPDATE_OFFERS).bind(JSON.stringify(toUpdate), ownerId),
    d1.prepare(INSERT_HISTORY).bind(JSON.stringify(history), ownerId),
    d1.prepare(SELECT_BY("offers", "id, url", "url")).bind(JSON.stringify(urls), ownerId),
  ]);

  const idOf = new Map(
    (idRows.results as { id: number; url: string }[]).map((row) => [row.url, row.id]),
  );
  return {
    created,
    updated,
    offerIds: items.map((item) => idOf.get(item.payload.url)!).filter((id) => id !== undefined),
  };
}

// --------------------------------------------------------------------------- //
// Corrección manual
// --------------------------------------------------------------------------- //
/**
 * Escribe una corrección manual y **ancla** los campos que ha tocado. Se anclan
 * los campos que vienen en el cuerpo, no los que han cambiado de valor:
 * confirmar a mano el dato que ya estaba también es decir «este lo llevo yo».
 *
 * No se recalcula nada aquí: las métricas se computan al leer. Lo que no se
 * rehace es el veredicto del agente de IA, que es de un run pasado.
 */
export async function applyManualEdit(
  db: Db,
  offer: Offer,
  payload: OfferUpdate,
  userId: string,
): Promise<void> {
  const { clear_manual: clearManual, ...changes } = payload;
  const pinned = new Set<string>(clearManual ? [] : offer.manual_fields);
  const touched = Object.keys(changes).filter((field) =>
    (EDITABLE_FIELDS as readonly string[]).includes(field),
  );

  const set: Partial<Offer> = {};
  for (const field of touched) {
    const value = (changes as Record<string, unknown>)[field];
    (set as Record<string, unknown>)[field] =
      (field === "price" || field === "original_price") && typeof value === "number"
        ? toCents(value)
        : value;
  }

  const statements: BatchItem<"sqlite">[] = [];
  // La corrección del precio se anota en el historial como cualquier otro
  // cambio: si no, el último punto de la serie dejaría de coincidir con la ficha.
  if (set.price !== undefined && toCents(offer.price) !== set.price) {
    statements.push(db.insert(offerPriceHistory).values({ offer_id: offer.id, price: set.price! }));
  }
  statements.push(
    db
      .update(offers)
      .set({
        ...set,
        manual_fields: [...new Set([...pinned, ...touched])]
          .filter((field) => (EDITABLE_FIELDS as readonly string[]).includes(field))
          .sort(),
        edited_at: nowIso(),
        edited_by_id: userId,
      })
      .where(and(eq(offers.id, offer.id), eq(offers.user_id, offer.user_id))),
  );
  await runBatch(db, statements);
}
