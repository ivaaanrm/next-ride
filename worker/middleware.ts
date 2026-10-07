/**
 * Las dos puertas de la API: sesión de persona (Better Auth) y, en los
 * endpoints que usa el skill, también `X-API-Key`.
 *
 * Las dos dicen además en qué cuenta se está (`tenantId`): la de la persona, o
 * la dueña de la API key. Todo lo que hay detrás filtra por esa cuenta, con
 * las reglas de `lib/tenant.ts`.
 */
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

import type { AppEnv } from "./app";
import { apiKeys, nowIso, users } from "./db/schema";
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
  c.set("tenantId", user.id);
  await next();
});

/** Endpoints de administración: con sesión y además superusuario, o 403. */
export const requireSuperuser = createMiddleware<AppEnv>(async (c, next) => {
  const user = await sessionUser(c);
  if (!user) throw CREDENTIALS_ERROR();
  if (!user.isSuperuser) throw forbidden("Solo un administrador puede hacer esto");
  c.set("user", user);
  c.set("tenantId", user.id);
  await next();
});

/**
 * Endpoints de ingesta y configuración del skill: sesión o `X-API-Key`.
 *
 * Una clave vale lo que su cuenta: sin dueña (no debería haberlas) no entra, y
 * con la dueña desactivada tampoco, igual que no entraría ella con su sesión.
 */
export const requireIngest = createMiddleware<AppEnv>(async (c, next) => {
  const raw = c.req.header("X-API-Key");
  if (raw) {
    const prefix = apiKeyPrefix(raw);
    const [row] = prefix
      ? await c.var.db
          .select({ key: apiKeys, ownerActive: users.isActive })
          .from(apiKeys)
          .innerJoin(users, eq(users.id, apiKeys.user_id))
          .where(
            and(
              eq(apiKeys.prefix, prefix),
              eq(apiKeys.hashed_key, await hashApiKey(raw)),
              eq(apiKeys.is_active, true),
            ),
          )
      : [];
    if (!row) throw new ApiError(401, "API key no válida");
    if (!row.ownerActive) throw forbidden("La cuenta de esta API key está desactivada");
    const { key } = row;
    // La marca de último uso no tiene por qué retrasar la respuesta.
    c.executionCtx.waitUntil(
      c.var.db.update(apiKeys).set({ last_used_at: nowIso() }).where(eq(apiKeys.id, key.id)),
    );
    c.set("principal", { user: null, apiKey: key });
    c.set("tenantId", key.user_id);
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
  c.set("tenantId", user.id);
  await next();
});
