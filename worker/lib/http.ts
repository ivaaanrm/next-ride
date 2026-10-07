/**
 * Errores con la misma forma que daba FastAPI, que es la que lee el frontend
 * (`extractError` en `src/lib/api.ts`):
 *
 *   {"detail": "texto"}                                   4xx con mensaje
 *   {"detail": [{"loc": ["body", "campo"], "msg": "…"}]}  422 de validación
 */
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

export class ApiError extends HTTPException {
  constructor(
    status: ContentfulStatusCode,
    readonly detail: string | ValidationIssue[],
    readonly headers: Record<string, string> = {},
  ) {
    super(status, { message: typeof detail === "string" ? detail : "Validation error" });
  }
}

export interface ValidationIssue {
  loc: (string | number)[];
  msg: string;
  type: string;
}

export const notFound = (detail: string) => new ApiError(404, detail);
export const conflict = (detail: string) => new ApiError(409, detail);
export const forbidden = (detail: string) => new ApiError(403, detail);
export const unprocessable = (detail: string | ValidationIssue[]) => new ApiError(422, detail);

export function zodIssues(error: z.ZodError, location: string): ValidationIssue[] {
  return error.issues.map((issue) => ({
    loc: [location, ...issue.path.map((part) => (typeof part === "symbol" ? String(part) : part))],
    msg: issue.message,
    type: issue.code,
  }));
}

export function errorResponse(error: unknown, c: Context): Response {
  if (error instanceof ApiError) {
    return c.json({ detail: error.detail }, error.status, error.headers);
  }
  if (error instanceof HTTPException) {
    return c.json({ detail: error.message }, error.status);
  }
  console.error(
    JSON.stringify({
      message: "unhandled error",
      path: c.req.path,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    }),
  );
  return c.json({ detail: "Error interno del servidor" }, 500);
}

// --------------------------------------------------------------------------- //
// Validación del cuerpo y de la query
// --------------------------------------------------------------------------- //

/** El cuerpo JSON validado. Sin cuerpo (o vacío) se valida `undefined`. */
export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let raw: unknown = undefined;
  const text = await c.req.text();
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw unprocessable([{ loc: ["body"], msg: "JSON mal formado", type: "json_invalid" }]);
    }
  }
  const result = schema.safeParse(raw);
  if (!result.success) throw unprocessable(zodIssues(result.error, "body"));
  return result.data;
}

/** La query validada. Los valores repetidos se quedan con el último, como FastAPI. */
export function parseQuery<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  const result = schema.safeParse(c.req.query());
  if (!result.success) throw unprocessable(zodIssues(result.error, "query"));
  return result.data;
}

export function parseId(c: Context, name: string): number {
  const value = Number(c.req.param(name));
  if (!Number.isInteger(value)) {
    throw unprocessable([
      { loc: ["path", name], msg: "Debe ser un número entero", type: "int_parsing" },
    ]);
  }
  return value;
}

// --------------------------------------------------------------------------- //
// Tipos de query con la coerción que hacía FastAPI
// --------------------------------------------------------------------------- //
const TRUE = new Set(["1", "true", "t", "yes", "y", "on"]);
const FALSE = new Set(["0", "false", "f", "no", "n", "off"]);

/** Booleano de query: `true/false/1/0/yes/no/on/off`, ausente = `false`. */
export const qBool = z
  .string()
  .optional()
  .transform((value, ctx) => {
    if (value === undefined || value === "") return false;
    const lowered = value.toLowerCase();
    if (TRUE.has(lowered)) return true;
    if (FALSE.has(lowered)) return false;
    ctx.addIssue({ code: "custom", message: "Debe ser un booleano" });
    return z.NEVER;
  });

/** Número de query opcional; vacío cuenta como ausente. */
export const qNumber = (schema: z.ZodNumber = z.number()) =>
  z.preprocess(
    (value) => (value === undefined || value === "" ? undefined : Number(value)),
    schema.optional(),
  );

export const qInt = (schema: z.ZodNumber = z.number()) => qNumber(schema.int());

export const qString = z
  .string()
  .optional()
  .transform((value) => (value === "" ? undefined : value));
