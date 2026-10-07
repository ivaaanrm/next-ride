/**
 * Correo saliente con Cloudflare Email Sending (binding `EMAIL`).
 *
 * Solo transaccional: hoy, la invitación. El remitente es `MAIL_FROM`, que el
 * binding restringe en `wrangler.jsonc`. En `pnpm dev` y en las pruebas el
 * binding es simulado y el mensaje acaba en la consola, no en un buzón.
 */

export interface MailResult {
  sent: boolean;
  /** Código del binding (`E_SENDER_NOT_VERIFIED`…) cuando no ha salido. */
  error?: string;
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

interface InvitationMail {
  to: string;
  url: string;
  inviter: string;
  expiresAt: Date;
}

export function invitationMessage({ url, inviter, expiresAt }: InvitationMail) {
  const until = expiresAt.toLocaleDateString("es-ES", {
    day: "numeric",
    month: "long",
    timeZone: "Europe/Madrid",
  });
  const subject = `${inviter} te invita a cochesradar`;
  const text = [
    `${inviter} te ha invitado a cochesradar, las mejores ofertas de coches en un único sitio.`,
    "",
    "Para crear tu cuenta, abre este enlace y elige una contraseña:",
    url,
    "",
    `El enlace vale hasta el ${until} y solo sirve una vez.`,
    "Si no esperabas este correo, ignóralo: sin abrir el enlace no se crea nada.",
  ].join("\n");
  const html = `<!doctype html>
<html lang="es">
  <body style="margin:0;padding:24px;background:#f5f5f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1c1917">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;padding:32px">
          <tr><td>
            <h1 style="margin:0 0 16px;font-size:22px">cochesradar</h1>
            <p style="margin:0 0 16px;font-size:16px;line-height:1.5">
              ${escapeHtml(inviter)} te ha invitado a cochesradar, las mejores ofertas de coches en un único sitio.
            </p>
            <p style="margin:0 0 24px">
              <a href="${escapeHtml(url)}" style="display:inline-block;background:#1c1917;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">Crear mi cuenta</a>
            </p>
            <p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#57534e">
              El enlace vale hasta el ${escapeHtml(until)} y solo sirve una vez. Si el botón no funciona, copia esta dirección en el navegador:
            </p>
            <p style="margin:0 0 24px;font-size:13px;word-break:break-all;color:#57534e">${escapeHtml(url)}</p>
            <p style="margin:0;font-size:13px;color:#a8a29e">
              Si no esperabas este correo, ignóralo: sin abrir el enlace no se crea nada.
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
  return { subject, text, html };
}

export async function sendInvitationEmail(env: Env, mail: InvitationMail): Promise<MailResult> {
  const { subject, text, html } = invitationMessage(mail);
  try {
    await env.EMAIL.send({
      to: mail.to,
      from: { email: env.MAIL_FROM, name: "cochesradar" },
      subject,
      text,
      html,
    });
    return { sent: true };
  } catch (error) {
    // La invitación ya existe: si el correo no sale, el administrador tiene el
    // enlace en la respuesta y puede mandarlo por otro lado.
    const code = (error as { code?: string })?.code ?? "E_UNKNOWN";
    console.error(
      JSON.stringify({
        message: "invitation email failed",
        code,
        error: String((error as Error)?.message ?? error),
      }),
    );
    return { sent: false, error: code };
  }
}
