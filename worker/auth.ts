/**
 * Autenticación de personas con Better Auth: email y contraseña, sesión en
 * cookie HttpOnly de primera parte.
 *
 * La cookie sustituye al par access/refresh en `localStorage` de antes, y en
 * una PWA instalada en iOS es la diferencia que importa: WebKit desaloja el
 * almacenamiento escribible por script a los siete días sin visitas, y una
 * cookie puesta por el servidor del mismo origen no entra en esa cuenta.
 *
 * El scraper no pasa por aquí: se autentica con `X-API-Key` (`middleware.ts`).
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { eq } from "drizzle-orm";

import { accounts, sessions, users, verifications } from "./db/schema";
import { getDb } from "./lib/db";
import { hashPassword, verifyPassword } from "./lib/security";

export const AUTH_BASE_PATH = "/api/auth";

export const registrationEnabled = (env: Env) =>
  ["1", "true", "yes", "on"].includes(String(env.ALLOW_REGISTRATION ?? "").toLowerCase());

function buildAuth(env: Env, baseURL: string) {
  const db = getDb(env);
  return betterAuth({
    appName: "next-ride",
    baseURL,
    basePath: AUTH_BASE_PATH,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: { user: users, session: sessions, account: accounts, verification: verifications },
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !registrationEnabled(env),
      minPasswordLength: 8,
      maxPasswordLength: 128,
      autoSignIn: true,
      password: { hash: hashPassword, verify: verifyPassword },
    },
    user: {
      additionalFields: {
        // Los dos los decide el servidor: `input: false` impide que un registro
        // se los ponga a sí mismo.
        isActive: { type: "boolean", defaultValue: true, input: false },
        isSuperuser: { type: "boolean", defaultValue: false, input: false },
        lastLoginAt: { type: "date", required: false, input: false },
      },
    },
    session: {
      // Treinta días deslizantes: la app se abre un par de veces por semana, y
      // pedir la contraseña cada pocos días en el móvil es un peaje sin motivo.
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      // Cinco minutos de sesión firmada en cookie: la mayoría de peticiones no
      // tocan D1 para saber quién pregunta.
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    rateLimit: {
      enabled: env.ENVIRONMENT !== "local",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 10 },
        "/sign-up/email": { window: 60, max: 5 },
      },
    },
    databaseHooks: {
      session: {
        create: {
          // Un usuario desactivado no abre sesión, igual que antes no recibía token.
          before: async (session) => {
            const [user] = await db
              .select({ isActive: users.isActive })
              .from(users)
              .where(eq(users.id, session.userId));
            if (user && !user.isActive) {
              throw new APIError("FORBIDDEN", { message: "Usuario desactivado" });
            }
          },
          after: async (session) => {
            await db
              .update(users)
              .set({ lastLoginAt: new Date() })
              .where(eq(users.id, session.userId));
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof buildAuth>;
export type SessionUser = Auth["$Infer"]["Session"]["user"];

// Una instancia por origen y aislado: construirla en cada petición rehace el
// enrutado de todos sus endpoints. El origen entra en la clave porque es el
// `baseURL` con el que Better Auth valida el `Origin` de las mutaciones.
const instances = new Map<string, Auth>();

export function getAuth(env: Env, request: Request): Auth {
  const origin = new URL(request.url).origin;
  let auth = instances.get(origin);
  if (!auth) {
    auth = buildAuth(env, origin);
    instances.set(origin, auth);
  }
  return auth;
}
