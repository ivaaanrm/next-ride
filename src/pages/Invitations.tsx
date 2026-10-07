import { useState, type FormEvent } from "react";

import { PageHeader } from "../components/Layout";
import { useTouchLayout } from "../components/SwipeRow";
import { Banner, Chip, Empty, Loading } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatDateTime } from "../lib/format";
import { useAsync } from "../lib/hooks";
import type { Invitation, InvitationCreated, InvitationStatus } from "../types";

const STATUS: Record<InvitationStatus, { label: string; tone: "positive" | "neutral" | "warm" }> = {
  pending: { label: "Pendiente", tone: "warm" },
  accepted: { label: "Aceptada", tone: "positive" },
  revoked: { label: "Anulada", tone: "neutral" },
  expired: { label: "Caducada", tone: "neutral" },
};

const inviteMeta = (invitation: Invitation): string =>
  invitation.status === "accepted"
    ? `aceptada ${formatDateTime(invitation.accepted_at)}`
    : invitation.status === "pending"
      ? `vale hasta ${formatDateTime(invitation.expires_at)}`
      : `enviada ${formatDateTime(invitation.created_at)}`;

/**
 * Invitaciones: la única forma de dar de alta a alguien con el registro
 * cerrado. Solo para superusuarios (el servidor responde 403 a los demás).
 */
export function InvitationsPage() {
  const { user } = useAuth();
  const isAdmin = user?.is_superuser === true;
  const list = useAsync<Invitation[]>(
    () => (isAdmin ? api.get("/invitations") : Promise.resolve([])),
    [isAdmin],
  );
  const touch = useTouchLayout();

  const [email, setEmail] = useState("");
  const [created, setCreated] = useState<InvitationCreated | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pending = (list.data ?? []).filter((row) => row.status === "pending").length;

  async function send(event: FormEvent, to = email) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      setCreated(await api.post<InvitationCreated>("/invitations", { email: to.trim() }));
      setEmail("");
      list.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo enviar la invitación");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(invitation: Invitation) {
    if (!confirm(`¿Anular la invitación a ${invitation.email}? El enlace dejará de valer.`)) return;
    setError(null);
    try {
      await api.delete(`/invitations/${invitation.id}`);
      list.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo anular la invitación");
    }
  }

  const actions = (invitation: Invitation) =>
    invitation.status === "accepted" ? null : invitation.status === "pending" ? (
      <button
        type="button"
        className="btn btn-ghost btn-sm btn-danger"
        aria-label={`Anular la invitación a ${invitation.email}`}
        onClick={() => revoke(invitation)}
      >
        Anular
      </button>
    ) : (
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        aria-label={`Volver a invitar a ${invitation.email}`}
        disabled={busy}
        onClick={(event) => send(event, invitation.email)}
      >
        Reenviar
      </button>
    );

  if (!isAdmin) {
    return (
      <>
        <PageHeader title="Invitaciones" />
        <div className="content">
          <Empty title="Solo para administradores" hint="Pide a un administrador que invite a quien quieras." />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Invitaciones"
        meta={list.data ? `${pending} pendiente${pending === 1 ? "" : "s"}` : undefined}
      />

      <div className="content stack" style={{ maxWidth: 860 }}>
        <div className="card">
          <p className="card-title">Invitar a alguien</p>
          <p className="tiny muted" style={{ marginTop: -4 }}>
            Le llega un email desde <code className="mono">no-reply@cochesradar.com</code> con un
            enlace de un solo uso para elegir su contraseña. Volver a invitar al mismo email anula
            el enlace anterior.
          </p>

          {error ? <Banner kind="error">{error}</Banner> : null}

          {created ? (
            <Banner kind={created.email_sent ? "info" : "warn"}>
              <div>
                {created.email_sent ? (
                  <>
                    <strong>Invitación enviada a {created.email}.</strong> Si no le llega, puedes
                    pasarle el enlace por otro lado:
                  </>
                ) : (
                  <>
                    <strong>El email no ha salido</strong> ({created.email_error}). La invitación
                    vale igual: pásale este enlace por otro lado.
                  </>
                )}
                <div className="mono" style={{ marginTop: 6, wordBreak: "break-all" }}>
                  {created.invite_url}
                </div>
                <button
                  className="btn btn-sm"
                  style={{ marginTop: 8 }}
                  onClick={() => {
                    navigator.clipboard?.writeText(created.invite_url);
                    setCreated(null);
                  }}
                >
                  Copiar y cerrar
                </button>
              </div>
            </Banner>
          ) : null}

          <form className="field" style={{ margin: "10px 0 14px" }} onSubmit={send}>
            <label htmlFor="invite-email">Email</label>
            <div className="row">
              <input
                id="invite-email"
                className="input grow"
                type="email"
                placeholder="nombre@ejemplo.com"
                inputMode="email"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="send"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
              <button className="btn btn-primary" type="submit" disabled={busy}>
                {busy ? <span className="spinner" /> : null} Invitar
              </button>
            </div>
          </form>

          {list.loading || (list.data ?? []).length === 0 ? (
            <div className="table-wrap">
              {list.loading ? (
                <Loading />
              ) : (
                <Empty title="No hay invitaciones" hint="Invita a alguien con su email." />
              )}
            </div>
          ) : touch ? (
            <ul className="record-list">
              {(list.data ?? []).map((invitation) => (
                <li key={invitation.id} className="record-item split key-item">
                  <div className="key-body">
                    <div className="record-head">
                      <span className="record-title">{invitation.email}</span>
                      <Chip tone={STATUS[invitation.status].tone}>
                        {STATUS[invitation.status].label}
                      </Chip>
                    </div>
                    <div className="record-meta key-dates">{inviteMeta(invitation)}</div>
                  </div>
                  <div className="record-actions">{actions(invitation)}</div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="table-wrap">
              <table className="records">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Estado</th>
                    <th>Enviada</th>
                    <th>Caduca</th>
                    <th style={{ width: 100 }} />
                  </tr>
                </thead>
                <tbody>
                  {(list.data ?? []).map((invitation) => (
                    <tr key={invitation.id}>
                      <td className="cell-primary">{invitation.email}</td>
                      <td>
                        <Chip tone={STATUS[invitation.status].tone}>
                          {STATUS[invitation.status].label}
                        </Chip>
                      </td>
                      <td className="cell-muted tiny">{formatDateTime(invitation.created_at)}</td>
                      <td className="cell-muted tiny">
                        {invitation.status === "accepted"
                          ? "—"
                          : formatDateTime(invitation.expires_at)}
                      </td>
                      <td>
                        <div className="row-actions">{actions(invitation)}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
