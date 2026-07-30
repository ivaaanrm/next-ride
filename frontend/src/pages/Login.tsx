import { useState, type FormEvent } from "react";

import { Banner } from "../components/ui";
import { useAuth } from "../lib/auth";

export function LoginPage() {
  const { login, register } = useAuth();
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
      setError(err instanceof Error ? err.message : "No se pudo completar la operación");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <h1>next-ride</h1>
        <p className="sub">
          {isRegister
            ? "Crea una cuenta para seguir modelos y ver las mejores ofertas."
            : "Las mejores ofertas de coches, en un único sitio."}
        </p>

        {error ? <Banner kind="error">{error}</Banner> : null}

        <form className="auth-form" onSubmit={submit}>
          {isRegister ? (
            <div className="field">
              <label htmlFor="name">Nombre</label>
              <input
                id="name"
                className="input"
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                autoComplete="name"
              />
            </div>
          ) : null}

          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              className="input"
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              autoFocus
            />
          </div>

          <div className="field">
            <label htmlFor="password">Contraseña</label>
            <input
              id="password"
              className="input"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={isRegister ? "new-password" : "current-password"}
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
