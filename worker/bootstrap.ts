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
 *   pasar por la interfaz. Una revocada se queda revocada.
 *
 * Las fuentes y targets de rastreo por defecto sí son SQL puro:
 * `migrations/0001_seed_scraping.sql`.
 */
import { eq } from "drizzle-orm";

import type { Auth } from "./auth";
import { apiKeys } from "./db/schema";
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
  await seedSuperuser(env, auth);
  await seedBootstrapApiKey(env, db);
}

async function seedSuperuser(env: Env, auth: Auth): Promise<void> {
  const email = env.FIRST_SUPERUSER_EMAIL?.trim().toLowerCase();
  const password = env.FIRST_SUPERUSER_PASSWORD;
  if (!email || !password) return;

  const ctx = await auth.$context;
  if (await ctx.internalAdapter.findUserByEmail(email)) return;

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
}

async function seedBootstrapApiKey(env: Env, db: Db): Promise<void> {
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
  // usar una clave revocada, se crea otra.
  const [existing] = await db.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.hashed_key, hashed));
  if (existing) return;
  await db
    .insert(apiKeys)
    .values({ name: "scraper (bootstrap)", prefix, hashed_key: hashed, is_active: true })
    .onConflictDoNothing();
  console.log(JSON.stringify({ message: "bootstrap api key registered", prefix }));
}
