import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";

import { Logo } from "../components/Logo";
import { Banner, Loading, OfflineNotice } from "../components/ui";
import { api, isUnreachable } from "../lib/api";
import { useAuth } from "../lib/auth";

/** Saca el token de la barra de direcciones: no tiene por qué quedarse en el historial. */
function takeToken(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("token");
}

/**
 * El enlace del email de invitación (`/invite?token=…`).
 *
 * Se pinta fuera de la app: quien llega aquí no tiene sesión. El email no se
 * teclea —viene de la invitación y es el que ha demostrado ser suyo al abrir
 * el enlace—, así que el formulario es nombre y contraseña.
 */
export function InvitePage() {
  const { user, login, logout } = useAuth();
  const navigate = useNavigate();
  // Fuera de la página con `replace`: el enlace, con su token, no se queda en
  // el historial para volver atrás a él.
  const leave = () => navigate("/offers", { replace: true });
  const [accepted, setAccepted] = useState(false);
  const [token] = useState(takeToken);
  const [email, setEmail] = useState<string | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(token ? null : "El enlace no está completo.");
  const [offline, setOffline] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token || user) return;
    setOffline(false);
    api
      .post<{ email: string }>("/invitations/lookup", { token })
      .then((res) => setEmail(res.email))
      .catch((err) => {
        if (isUnreachable(err)) setOffline(true);
        else setLookupError(err instanceof Error ? err.message : "La invitación no vale.");
      });
  }, [token, user, attempt]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!token || !email) return;
    setError(null);
    setBusy(true);
    try {
      await api.post("/invitations/accept", {
        token,
        name: fullName.trim() || undefined,
        password,
      });
      setAccepted(true);
      await login(email, password);
    } catch (err) {
      setAccepted(false);
      setError(err instanceof Error ? err.message : "No se pudo crear la cuenta");
      setBusy(false);
    }
  }

  // Recién creada la cuenta y abierta la sesión: a la app.
  useEffect(() => {
    if (accepted && user) navigate("/offers", { replace: true });
  }, [accepted, user, navigate]);

  if (accepted && user) {
    return (
      <div className="auth-shell">
        <Loading label="Entrando…" />
      </div>
    );
  }

  // Abrir el enlace con otra sesión abierta: no se mezclan cuentas sin avisar.
  if (user) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <div className="auth-brand">
            <Logo size={56} className="auth-logo" />
            <h1>cochesradar</h1>
          </div>
          <p className="sub">
            Ya has entrado como <strong>{user.email}</strong>. Para aceptar la invitación con
            otra cuenta, cierra antes esta sesión.
          </p>
          <div className="auth-form">
            <button className="btn btn-primary btn-lg" type="button" onClick={logout}>
              Cerrar sesión
            </button>
            <button
              className="btn btn-lg"
              type="button"
              onClick={leave}
            >
              Seguir con esta cuenta
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <Logo size={56} className="auth-logo" />
          <h1>cochesradar</h1>
        </div>

        {offline ? (
          <OfflineNotice onRetry={() => setAttempt((n) => n + 1)} retrying={false} />
        ) : lookupError ? (
          <>
            <Banner kind="error">{lookupError}</Banner>
            <div className="auth-switch">
              <button
                type="button"
                onClick={leave}
              >
                Ir a la pantalla de entrada
              </button>
            </div>
          </>
        ) : !email ? (
          <Loading label="Comprobando la invitación…" />
        ) : (
          <>
            <p className="sub">Te han invitado. Elige una contraseña para crear tu cuenta.</p>

            {error ? <Banner kind="error">{error}</Banner> : null}

            <form className="auth-form" onSubmit={submit}>
              {/* El email va en el formulario, aunque no se edite, para que el
                  gestor de contraseñas guarde la pareja email + contraseña. */}
              <div className="field">
                <label htmlFor="email">Email</label>
                <input
                  id="email"
                  name="email"
                  className="input"
                  type="email"
                  value={email}
                  readOnly
                  autoComplete="username"
                />
              </div>

              <div className="field">
                <label htmlFor="name">Nombre</label>
                <input
                  id="name"
                  name="name"
                  className="input"
                  value={fullName}
                  onChange={(event) => setFullName(event.target.value)}
                  autoComplete="name"
                  autoCapitalize="words"
                  enterKeyHint="next"
                  autoFocus
                />
              </div>

              <div className="field">
                <label htmlFor="password">Contraseña</label>
                <input
                  id="password"
                  name="password"
                  className="input"
                  type="password"
                  required
                  minLength={8}
                  maxLength={128}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                  enterKeyHint="go"
                />
              </div>

              <button className="btn btn-primary btn-lg" type="submit" disabled={busy}>
                {busy ? <span className="spinner" /> : null}
                Crear cuenta
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
