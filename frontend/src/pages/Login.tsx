import { useState, type FormEvent } from "react";

import { Banner, OfflineNotice } from "../components/ui";
import { useAuth } from "../lib/auth";

export function LoginPage() {
  const { login, register, offline, retrying, retry, sessionEnded } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isRegister = mode === "register";

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (isRegister) {
        await register(email.trim(), password, fullName.trim() || undefined);
      } else {
        await login(email.trim(), password);
      }
    } catch (err) {
      // `NetworkError` llega con «No hay conexión con el servidor» y `ApiError`
      // con el mensaje del backend, que también está en español.
      setError(err instanceof Error ? err.message : "No se pudo completar la operación");
    } finally {
      setBusy(false);
    }
  }

  /* Hay tokens guardados y el servidor no ha contestado. Pedir la contraseña
   * aquí sería mentir dos veces: ni sabemos que la sesión ha caducado, ni
   * teclearla serviría de nada sin red. Se dice lo que pasa y se ofrece lo
   * único que puede funcionar. */
  if (offline) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <h1>next-ride</h1>
          <OfflineNotice onRetry={retry} retrying={retrying} />
        </div>
      </div>
    );
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <h1>next-ride</h1>
        <p className="sub">
          {isRegister
            ? "Crea una cuenta para seguir modelos y ver las mejores ofertas."
            : sessionEnded
              ? "Tu sesión ha caducado, que es lo normal tras unos días sin abrir la app. Vuelve a entrar."
              : "Las mejores ofertas de coches, en un único sitio."}
        </p>

        {error ? <Banner kind="error">{error}</Banner> : null}

        <form className="auth-form" onSubmit={submit}>
          {isRegister ? (
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
              />
            </div>
          ) : null}

          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              name="email"
              className="input"
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              /* El teclado de email trae la @ y el punto en la fila principal.
                 Las tres correcciones de al lado son de iOS: sin ellas escribe
                 «Ivan@…» con mayúscula y subraya el dominio como falta. */
              inputMode="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              /* Queda un campo por delante: la tecla de retorno lo dice. */
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
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={isRegister ? "new-password" : "current-password"}
              /* Último campo del formulario: la tecla de retorno envía, y así
                 no hay que buscar el botón por debajo del teclado. */
              enterKeyHint="go"
            />
          </div>

          <button className="btn btn-primary btn-lg" type="submit" disabled={busy}>
            {busy ? <span className="spinner" /> : null}
            {isRegister ? "Crear cuenta" : "Entrar"}
          </button>
        </form>

        <div className="auth-switch">
          {isRegister ? "¿Ya tienes cuenta? " : "¿Todavía no tienes cuenta? "}
          <button
            type="button"
            onClick={() => {
              setMode(isRegister ? "login" : "register");
              setError(null);
            }}
          >
            {isRegister ? "Entrar" : "Regístrate"}
          </button>
        </div>
      </div>
    </div>
  );
}
