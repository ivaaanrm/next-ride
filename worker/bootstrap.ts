/**
 * Datos iniciales que no caben en una migración SQL, una vez por aislado.
 *
 * Es lo que hacía `init_db` al arrancar el contenedor. Un Worker no tiene
 * arranque, así que se hace en la primera petición que llega a cada aislado:
 *
 * - El superusuario de `FIRST_SUPERUSER_EMAIL` / `FIRST_SUPERUSER_PASSWORD`,
 *   si no existe. El hash de la contraseña no se puede escribir en SQL.
 * - La API key de `BOOTSTRAP_SCRAPER_API_KEY`, si no está registrada. Así la
 *   `NR_API_KEY` que ya tiene el skill sigue valiendo tras la migración sin
 *   pasar por la interfaz. Una revocada se queda revocada. Es del
 *   superusuario: lo que ingesta entra en su cuenta.
 * - Los targets de rastreo sin dueña, que pasan al superusuario. Las fuentes y
 *   targets por defecto son SQL puro (`migrations/0001_seed_scraping.sql`), y
 *   en una base nueva esa semilla llega antes que ninguna cuenta: hasta que
 *   tiene dueña no la ve nadie.
 */
import { and, eq, isNull } from "drizzle-orm";

import type { Auth } from "./auth";
import { apiKeys, scrapeTargets } from "./db/schema";
import type { Db } from "./lib/db";
import { apiKeyPrefix, hashApiKey } from "./lib/security";

let done: Promise<void> | null = null;

export function ensureBootstrapped(env: Env, db: Db, auth: Auth): Promise<void> {
  done ??= run(env, db, auth).catch((error) => {
    // Sin migrar, o con D1 caído: se vuelve a intentar en la siguiente petición.
    done = null;
    console.error(
      JSON.stringify({ message: "bootstrap failed", error: String(error?.message ?? error) }),
    );
  });
  return done;
}

async function run(env: Env, db: Db, auth: Auth): Promise<void> {
  const superuserId = await seedSuperuser(env, auth);
  if (!superuserId) {
    if (env.BOOTSTRAP_SCRAPER_API_KEY?.trim()) {
      console.warn(
        JSON.stringify({
          message: "BOOTSTRAP_SCRAPER_API_KEY ignorada: sin FIRST_SUPERUSER_* no hay cuenta a la que dársela",
        }),
      );
    }
    return;
  }
  await db
    .update(scrapeTargets)
    .set({ user_id: superuserId })
    .where(isNull(scrapeTargets.user_id));
  await seedBootstrapApiKey(env, db, superuserId);
}

/** El id del superusuario de los secretos, recién creado o de antes. */
async function seedSuperuser(env: Env, auth: Auth): Promise<string | null> {
  const email = env.FIRST_SUPERUSER_EMAIL?.trim().toLowerCase();
  const password = env.FIRST_SUPERUSER_PASSWORD;
  if (!email || !password) return null;

  const ctx = await auth.$context;
  const existing = await ctx.internalAdapter.findUserByEmail(email);
  if (existing) return existing.user.id;

  const user = await ctx.internalAdapter.createUser(
    { email, name: "Administrador", isSuperuser: true, isActive: true },
    { method: "admin" },
  );
  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: "credential",
    accountId: user.id,
    password: await ctx.password.hash(password),
  });
  console.log(JSON.stringify({ message: "superuser created", email }));
  return user.id;
}

async function seedBootstrapApiKey(env: Env, db: Db, ownerId: string): Promise<void> {
  const raw = env.BOOTSTRAP_SCRAPER_API_KEY?.trim();
  if (!raw) return;
  const prefix = apiKeyPrefix(raw);
  if (!prefix) {
    console.warn(
      JSON.stringify({
        message: "BOOTSTRAP_SCRAPER_API_KEY ignorada: el formato debe ser nr_<prefijo>_<secreto>",
      }),
    );
    return;
  }

  const hashed = await hashApiKey(raw);
  // Si ya existe no se toca, ni siquiera revocada: esto corre en cada aislado
  // nuevo (cada pocos minutos), y reactivarla aquí desharía cualquier
  // revocación. Antes solo pasaba al arrancar el contenedor. Para volver a
  // usar una clave revocada, se crea otra. Lo único que se completa es la
  // dueña, si no la tiene: sin ella la clave no entra.
  const [existing] = await db.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.hashed_key, hashed));
  if (existing) {
    await db
      .update(apiKeys)
      .set({ user_id: ownerId })
      .where(and(eq(apiKeys.id, existing.id), isNull(apiKeys.user_id)));
    return;
  }
  await db
    .insert(apiKeys)
    .values({ user_id: ownerId, name: "scraper (bootstrap)", prefix, hashed_key: hashed, is_active: true })
    .onConflictDoNothing();
  console.log(JSON.stringify({ message: "bootstrap api key registered", prefix }));
}
