/**
 * El cliente de Better Auth, en su propio módulo para cargarlo **bajo demanda**.
 *
 * Solo hace falta para entrar, registrarse y salir. Quien abre la app con la
 * sesión ya iniciada —casi siempre— no lo descarga: el arranque restaura la
 * sesión con `GET /api/v1/auth/me` y el presupuesto de bytes del primer
 * pintado no paga por una pantalla que no va a ver.
 */
import { createAuthClient } from "better-auth/client";

import { ApiError, NetworkError, authErrorMessage } from "./api";

export const authClient = createAuthClient({ basePath: "/api/auth" });

interface AuthResult<T> {
  data: T | null;
  error: { status: number; code?: string; message?: string } | null;
}

/**
 * Traduce el `{data, error}` de Better Auth a las dos clases de error del resto
 * de la app: `ApiError` si el servidor ha contestado que no, `NetworkError` si
 * no ha contestado (o ha contestado con un 5xx, que tampoco dice nada de la
 * credencial).
 */
export async function unwrap<T>(call: Promise<AuthResult<T>>): Promise<T> {
  let result: AuthResult<T>;
  try {
    result = await call;
  } catch (error) {
    throw new NetworkError("unreachable", error);
  }
  const { data, error } = result;
  if (error) {
    if (!error.status || error.status >= 500) throw new NetworkError("unreachable", error);
    throw new ApiError(error.status, authErrorMessage(error.status, error.code, error.message));
  }
  return data as T;
}
