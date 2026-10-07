/**
 * Lo que queda de `/auth` en la API propia. El alta, el login, el logout y la
 * sesión los sirve Better Auth en `/api/auth/*`; aquí solo está el usuario
 * actual con la forma que ya consume el frontend (`UserRead`), su edición, y
 * la configuración pública que necesita la pantalla de entrada.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";

import { router } from "../app";
import { registrationEnabled } from "../auth";
import { users } from "../db/schema";
import { parseBody } from "../lib/http";
import { requireUser } from "../middleware";
import { userRead } from "../services/serialize";

export const authRoutes = router();

/** Público: si la pantalla de entrada debe ofrecer «Regístrate». */
authRoutes.get("/config", (c) => c.json({ registration_enabled: registrationEnabled(c.env) }));

authRoutes.get("/me", requireUser, async (c) => {
  // De la base y no de la sesión: la sesión puede venir de la caché en cookie.
  const [user] = await c.var.db.select().from(users).where(eq(users.id, c.var.user.id));
  return c.json(userRead(user ?? c.var.user));
});

const UserUpdate = z.object({ full_name: z.string().max(200).nullish() });

/** El nombre. La contraseña se cambia con Better Auth (`/api/auth/change-password`). */
authRoutes.patch("/me", requireUser, async (c) => {
  const payload = await parseBody(c, UserUpdate);
  if (payload.full_name !== undefined && payload.full_name !== null) {
    await c.var.db
      .update(users)
      .set({ name: payload.full_name, updatedAt: new Date() })
      .where(eq(users.id, c.var.user.id));
  }
  const [user] = await c.var.db.select().from(users).where(eq(users.id, c.var.user.id));
  return c.json(userRead(user));
});
