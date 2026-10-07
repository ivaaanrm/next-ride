/**
 * Piezas de validación con la coerción «laxa» que hacía Pydantic, que es con la
 * que se han escrito los payloads del scraper: `"24590"` vale como número y
 * `2019.0` como entero. Cambiar eso aquí rompería ingestas que hoy funcionan.
 */
import { z } from "zod";

const toNumber = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))
    ? Number(value)
    : value;

/** Número que también acepta su forma en texto. */
export const num = (schema: z.ZodNumber = z.number()) => z.preprocess(toNumber, schema);

/** Entero que acepta `"2019"` y `2019.0`, pero no `2019.5`. */
export const int = (schema: z.ZodNumber = z.number()) => z.preprocess(toNumber, schema.int());

/** Cadena opcional que admite `null`, con tope de longitud. */
export const optStr = (max: number, min = 0) => z.string().min(min).max(max).nullish();

export const nullable = <T extends z.ZodType>(schema: T) =>
  schema.nullish().transform((value) => value ?? null);
