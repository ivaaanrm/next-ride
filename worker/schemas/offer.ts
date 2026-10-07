import { z } from "zod";

import { FUEL_TYPE, TRANSMISSION, VEHICLE_CONDITION } from "../db/schema";
import { int, nullable, num } from "./common";

/**
 * La URL tal y como la guardaba Pydantic (`HttpUrl`): normalizada según
 * WHATWG, que es lo que hacen tanto su núcleo en Rust como `new URL()`. Es la
 * clave natural del upsert, así que tiene que salir idéntica a la ya guardada.
 */
const HttpUrl = z
  .string()
  .max(2083)
  .transform((value, ctx) => {
    try {
      const url = new URL(value.trim());
      if (url.protocol === "http:" || url.protocol === "https:") return url.href;
    } catch {
      // cae al error de abajo
    }
    ctx.addIssue({ code: "custom", message: "Debe ser una URL http(s) válida" });
    return z.NEVER;
  });

const upper = (value: string | null | undefined) => (value ? value.toUpperCase() : value);

/** Una oferta encontrada. El dealer y la versión se resuelven (o se crean) por nombre. */
export const OfferIngest = z.object({
  url: HttpUrl,
  title: z.string().min(1).max(400),
  price: num(z.number().gt(0)),

  dealer_name: z.string().min(1).max(200),
  dealer_website: nullable(z.string().max(500)),
  dealer_city: nullable(z.string().max(120)),
  dealer_country: nullable(z.string().min(2).max(2)).transform(upper),

  make: z.string().min(1).max(80),
  model: z.string().min(1).max(120),
  trim: z.string().max(120).default(""),

  original_price: nullable(num(z.number().gt(0))),
  currency: z.string().min(3).max(3).default("EUR").transform((value) => value.toUpperCase()),
  external_id: nullable(z.string().max(200)),
  source: nullable(z.string().max(80)),
  year: nullable(int(z.number().min(1950).max(2100))),
  mileage_km: nullable(int(z.number().min(0))),
  power_hp: nullable(int(z.number().min(0))),
  condition: z.enum(VEHICLE_CONDITION).default("used"),
  fuel_type: nullable(z.enum(FUEL_TYPE)),
  transmission: nullable(z.enum(TRANSMISSION)),
  location: nullable(z.string().max(160)),
  image_url: nullable(z.string().max(1000)),
  raw: nullable(z.record(z.string(), z.unknown())),
});
export type OfferIngest = z.output<typeof OfferIngest>;

/**
 * Lote de ofertas. Cada elemento se valida por separado contra `OfferIngest`:
 * una oferta mal formada se reporta en `errors` en lugar de invalidar el lote.
 */
export const OfferBulkIngest = z.object({
  offers: z.array(z.record(z.string(), z.unknown())).min(1).max(500),
});

export interface IngestResult {
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
  offer_ids: number[];
}

/**
 * Las columnas que se pueden escribir a mano, en el orden en que se editan.
 * `url` no está y no debe estar (es la clave del upsert), ni la procedencia
 * (`external_id`, `source`, el payload crudo).
 */
export const EDITABLE_FIELDS = [
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
  "car_model_id",
  "dealer_id",
] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

/** Columnas `NOT NULL`: se pueden corregir, pero no vaciar. */
const REQUIRED_FIELDS = new Set(["title", "price", "currency", "condition", "car_model_id", "dealer_id"]);

/**
 * Corrección manual. **Solo viajan los campos que se tocan**: no mandar `year`
 * lo deja como está y mandar `year: null` lo borra. Cada campo que llega queda
 * anclado en `manual_fields` y el scraper deja de escribirlo.
 */
export const OfferUpdate = z
  .object({
    title: z.string().min(1).max(400).nullable(),
    price: num(z.number().gt(0)).nullable(),
    original_price: num(z.number().gt(0)).nullable(),
    currency: z
      .string()
      .min(3)
      .max(3)
      .nullable()
      .transform((value) => (value ? value.toUpperCase() : value)),
    year: int(z.number().min(1950).max(2100)).nullable(),
    mileage_km: int(z.number().min(0)).nullable(),
    power_hp: int(z.number().min(0)).nullable(),
    condition: z.enum(VEHICLE_CONDITION).nullable(),
    fuel_type: z.enum(FUEL_TYPE).nullable(),
    transmission: z.enum(TRANSMISSION).nullable(),
    location: z.string().max(160).nullable(),
    image_url: z.string().max(1000).nullable(),
    // Reatribuir a otra versión o dealer: la corrección más cara, porque cambia
    // el mercado (el binomio) contra el que se mide la oferta.
    car_model_id: int().nullable(),
    dealer_id: int().nullable(),
    // Suelta todos los anclajes: los valores se quedan, el scraper vuelve a mandar.
    clear_manual: z.boolean().default(false),
  })
  .partial()
  .superRefine((value, ctx) => {
    const empty = Object.entries(value)
      .filter(([field, fieldValue]) => REQUIRED_FIELDS.has(field) && fieldValue === null)
      .map(([field]) => field)
      .sort();
    if (empty.length) {
      ctx.addIssue({
        code: "custom",
        message: `Estos campos no pueden quedarse vacíos: ${empty.join(", ")}`,
      });
    }
  });
export type OfferUpdate = z.output<typeof OfferUpdate>;

/**
 * Las dos notas manuales (1-5 ★). Mismo contrato que `OfferUpdate`: no mandar
 * una nota la deja como está y mandarla a `null` la borra (vuelve a «sin dato»).
 */
export const OfferRatingUpdate = z.strictObject({
  equipment_rating: int(z.number().min(1).max(5)).nullable().optional(),
  apparent_condition_rating: int(z.number().min(1).max(5)).nullable().optional(),
});

export const OfferDismiss = z
  .object({ reason: z.string().max(500).nullish() })
  .nullish()
  .transform((value) => value?.reason ?? null);
