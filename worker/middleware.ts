/**
 * Las dos puertas de la API: sesión de persona (Better Auth) y, en los
 * endpoints que usa el skill, también `X-API-Key`.
 */
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

import type { AppEnv } from "./app";
import { apiKeys, nowIso } from "./db/schema";
import { ApiError, forbidden } from "./lib/http";
import { apiKeyPrefix, hashApiKey } from "./lib/security";

const CREDENTIALS_ERROR = () =>
  new ApiError(401, "Credenciales no válidas", { "WWW-Authenticate": "Bearer" });

async function sessionUser(c: Context<AppEnv>) {
  const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  if (!session.user.isActive) throw forbidden("Usuario desactivado");
  return session.user;
}

/** Endpoints de personas: sin sesión válida, 401. */
export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const user = await sessionUser(c);
  if (!user) throw CREDENTIALS_ERROR();
  c.set("user", user);
  await next();
});

/** Endpoints de ingesta y configuración del skill: sesión o `X-API-Key`. */
export const requireIngest = createMiddleware<AppEnv>(async (c, next) => {
  const raw = c.req.header("X-API-Key");
  if (raw) {
    const prefix = apiKeyPrefix(raw);
    const [key] = prefix
      ? await c.var.db
          .select()
          .from(apiKeys)
          .where(
            and(
              eq(apiKeys.prefix, prefix),
              eq(apiKeys.hashed_key, await hashApiKey(raw)),
              eq(apiKeys.is_active, true),
            ),
          )
      : [];
    if (!key) throw new ApiError(401, "API key no válida");
    // La marca de último uso no tiene por qué retrasar la respuesta.
    c.executionCtx.waitUntil(
      c.var.db.update(apiKeys).set({ last_used_at: nowIso() }).where(eq(apiKeys.id, key.id)),
    );
    c.set("principal", { user: null, apiKey: key });
    await next();
    return;
  }

  const user = await sessionUser(c);
  if (!user) {
    throw new ApiError(401, "Inicia sesión o aporta una cabecera X-API-Key", {
      "WWW-Authenticate": "Bearer",
    });
  }
  c.set("user", user);
  c.set("principal", { user, apiKey: null });
  await next();
});
