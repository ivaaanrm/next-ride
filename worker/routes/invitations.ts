/**
 * Alta por invitación.
 *
 * Con `ALLOW_REGISTRATION=false` (producción) nadie se registra solo: un
 * superusuario invita a un email, a ese buzón le llega un enlace de un solo uso
 * (`/invite?token=…`) y quien lo abre elige nombre y contraseña. Abrir el enlace
 * demuestra que el buzón es suyo, así que la cuenta nace con el email verificado.
 *
 * El token viaja siempre en el cuerpo de un POST y nunca en la URL de la API:
 * los logs del Worker guardan URLs, no cuerpos. La página `/invite` la sirve
 * Static Assets sin pasar por el Worker.
 */
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";

import { router } from "../app";
import { invitations, nowIso, users, type Invitation } from "../db/schema";
import type { Db } from "../lib/db";
import { ApiError, conflict, notFound, parseBody, parseId } from "../lib/http";
import { generateToken, hashToken } from "../lib/security";
import { requireSuperuser } from "../middleware";
import { sendInvitationEmail } from "../services/mail";

export const invitationsRoutes = router();

const DAY_MS = 24 * 60 * 60 * 1000;

const normalizeEmail = (email: string) => email.trim().toLowerCase();

type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

function statusOf(invitation: Invitation, now = nowIso()): InvitationStatus {
  if (invitation.accepted_at) return "accepted";
  if (invitation.revoked_at) return "revoked";
  if (invitation.expires_at <= now) return "expired";
  return "pending";
}

const invitationRead = (invitation: Invitation) => ({
  id: invitation.id,
  email: invitation.email,
  status: statusOf(invitation),
  expires_at: invitation.expires_at,
  created_at: invitation.created_at,
  accepted_at: invitation.accepted_at,
  email_sent_at: invitation.email_sent_at,
});

/** Por qué un token no vale, en palabras de quien lo ha recibido. */
function unusable(invitation: Invitation | undefined): ApiError {
  switch (invitation && statusOf(invitation)) {
    case "accepted":
      return new ApiError(410, "Esta invitación ya se ha usado. Entra con tu email y contraseña.");
    case "revoked":
      return new ApiError(410, "Esta invitación se ha anulado. Pide una nueva.");
    case "expired":
      return new ApiError(410, "Esta invitación ha caducado. Pide una nueva.");
    default:
      return notFound("La invitación no existe. Revisa que el enlace esté completo.");
  }
}

/**
 * La base de los enlaces. En producción, `APP_URL` fijo: invitar desde
 * workers.dev no debe mandar a nadie allí. En local, el origen de la petición,
 * que es el puerto que haya tocado a `pnpm dev`.
 */
const appUrl = (env: Env, request: Request) =>
  (env.ENVIRONMENT === "local" || !env.APP_URL ? new URL(request.url).origin : env.APP_URL).replace(
    /\/+$/,
    "",
  );

// --------------------------------------------------------------------------- //
// Administración (superusuario)
// --------------------------------------------------------------------------- //

invitationsRoutes.get("/", requireSuperuser, async (c) => {
  const rows = await c.var.db
    .select()
    .from(invitations)
    .orderBy(desc(invitations.created_at), desc(invitations.id))
    .limit(200);
  return c.json(rows.map(invitationRead));
});

/**
 * Invita (o vuelve a invitar) a un email. Una invitación nueva anula las
 * pendientes de ese email: solo vale el último enlace enviado.
 *
 * El enlace va también en la respuesta, y solo aquí, como la API key en claro:
 * si el correo no sale, o acaba en spam, el administrador lo puede mandar por
 * otro lado.
 */
invitationsRoutes.post("/", requireSuperuser, async (c) => {
  const payload = await parseBody(
    c,
    z.object({ email: z.string().trim().toLowerCase().pipe(z.email().max(254)) }),
  );
  const email = normalizeEmail(payload.email);
  const db = c.var.db;

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing) throw conflict("Ya hay una cuenta con ese email");

  const now = nowIso();
  await db
    .update(invitations)
    .set({ revoked_at: now })
    .where(
      and(
        eq(invitations.email, email),
        isNull(invitations.accepted_at),
        isNull(invitations.revoked_at),
      ),
    );

  const ttlDays = Number(c.env.INVITATION_TTL_DAYS) || 7;
  const expiresAt = new Date(Date.now() + ttlDays * DAY_MS);
  const { raw, hashed } = await generateToken();
  const [invitation] = await db
    .insert(invitations)
    .values({
      email,
      token_hash: hashed,
      invited_by_id: c.var.user.id,
      expires_at: expiresAt.toISOString(),
    })
    .returning();

  const url = `${appUrl(c.env, c.req.raw)}/invite?token=${raw}`;
  const mail = await sendInvitationEmail(c.env, {
    to: email,
    url,
    inviter: c.var.user.name || c.var.user.email,
    expiresAt,
  });

  let row = invitation;
  if (mail.sent) {
    [row] = await db
      .update(invitations)
      .set({ email_sent_at: nowIso() })
      .where(eq(invitations.id, invitation.id))
      .returning();
  }

  return c.json(
    { ...invitationRead(row), invite_url: url, email_sent: mail.sent, email_error: mail.error ?? null },
    201,
  );
});

invitationsRoutes.delete("/:id", requireSuperuser, async (c) => {
  const [row] = await c.var.db
    .update(invitations)
    .set({ revoked_at: nowIso() })
    .where(
      and(
        eq(invitations.id, parseId(c, "id")),
        isNull(invitations.accepted_at),
        isNull(invitations.revoked_at),
      ),
    )
    .returning({ id: invitations.id });
  if (!row) throw notFound("No hay ninguna invitación pendiente con ese id");
  return c.body(null, 204);
});

// --------------------------------------------------------------------------- //
// Públicos: quien ha recibido el enlace
// --------------------------------------------------------------------------- //

const TokenBody = z.object({ token: z.string().min(16).max(128) });

async function findByToken(db: Db, token: string) {
  const [row] = await db
    .select()
    .from(invitations)
    .where(eq(invitations.token_hash, await hashToken(token)));
  return row;
}

/** Para pintar el formulario: a qué email es y hasta cuándo vale. */
invitationsRoutes.post("/lookup", async (c) => {
  const { token } = await parseBody(c, TokenBody);
  const invitation = await findByToken(c.var.db, token);
  if (!invitation || statusOf(invitation) !== "pending") throw unusable(invitation);
  return c.json({ email: invitation.email, expires_at: invitation.expires_at });
});

const AcceptBody = TokenBody.extend({
  name: z.string().trim().max(200).optional(),
  password: z.string().min(8).max(128),
});

/**
 * Crea la cuenta. No abre sesión: el frontend entra a continuación con
 * `/api/auth/sign-in/email`, que es el camino de siempre (cookie, límites y
 * `lastLoginAt` incluidos).
 */
invitationsRoutes.post("/accept", async (c) => {
  const payload = await parseBody(c, AcceptBody);
  const db = c.var.db;
  const tokenHash = await hashToken(payload.token);

  // Reclamar primero, en una sola sentencia: dos envíos a la vez del mismo
  // enlace no pueden crear dos cuentas. D1 no tiene transacciones
  // interactivas, así que si lo de después falla se devuelve la invitación.
  const [claimed] = await db
    .update(invitations)
    .set({ accepted_at: nowIso() })
    .where(
      and(
        eq(invitations.token_hash, tokenHash),
        isNull(invitations.accepted_at),
        isNull(invitations.revoked_at),
        gt(invitations.expires_at, nowIso()),
      ),
    )
    .returning();
  if (!claimed) throw unusable(await findByToken(db, payload.token));

  const release = () =>
    db.update(invitations).set({ accepted_at: null }).where(eq(invitations.id, claimed.id));

  try {
    const ctx = await c.var.auth.$context;
    if (await ctx.internalAdapter.findUserByEmail(claimed.email)) {
      throw conflict("Ya hay una cuenta con este email. Entra con tu contraseña.");
    }
    const user = await ctx.internalAdapter.createUser(
      {
        email: claimed.email,
        name: payload.name ?? "",
        emailVerified: true,
        isActive: true,
        isSuperuser: false,
      },
      { method: "invitation" },
    );
    await ctx.internalAdapter.linkAccount({
      userId: user.id,
      providerId: "credential",
      accountId: user.id,
      password: await ctx.password.hash(payload.password),
    });
    await db
      .update(invitations)
      .set({ accepted_user_id: user.id })
      .where(eq(invitations.id, claimed.id));
    // Las demás invitaciones pendientes a este email ya no tienen sentido.
    await db
      .update(invitations)
      .set({ revoked_at: nowIso() })
      .where(
        and(
          eq(invitations.email, claimed.email),
          isNull(invitations.accepted_at),
          isNull(invitations.revoked_at),
        ),
      );
    return c.json({ email: claimed.email }, 201);
  } catch (error) {
    await release();
    throw error;
  }
});
