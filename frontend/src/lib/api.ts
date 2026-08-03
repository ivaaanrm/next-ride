import type { TokenPair } from "../types";

const BASE = import.meta.env.VITE_API_BASE_URL ?? "/api/v1";
const ACCESS_KEY = "nr.access_token";
const REFRESH_KEY = "nr.refresh_token";

/**
 * Corte de toda petición.
 *
 * Sin él, una red que acepta la conexión y luego no contesta —el salto de wifi
 * a datos, un portal cautivo, el metro— deja el spinner girando para siempre:
 * `fetch` no tiene tiempo de espera propio. 15 s es larguísimo para una
 * petición que va bien y es lo máximo que aguanta mirando quien tiene el
 * teléfono en la mano.
 */
const TIMEOUT_MS = 15_000;

/** Lo que ve el usuario cuando el servidor no ha contestado. Nunca «Load failed». */
export const NETWORK_MESSAGE = "No hay conexión con el servidor";

/** El servidor ha contestado, y ha contestado que no. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * No ha habido respuesta: DNS, conexión rechazada, modo avión, cuerpo cortado a
 * medias, o el corte de los 15 s de aquí arriba.
 *
 * Es una clase aparte de `ApiError` porque la decisión que cuelga de ella es la
 * contraria. Un 401 del servidor significa que la sesión no vale y hay que
 * borrarla; un fallo de transporte no dice **nada** sobre la sesión, y tratarlo
 * como si lo dijera es lo que hacía que un túnel sin cobertura obligara a
 * teclear la contraseña otra vez. Además lleva su propio mensaje en español:
 * el `TypeError` de WebKit se llama «Load failed» y el de Chrome «Failed to
 * fetch», y ninguno de los dos es para enseñárselo a nadie.
 */
export class NetworkError extends Error {
  constructor(
    readonly reason: "unreachable" | "timeout" = "unreachable",
    cause?: unknown,
  ) {
    super(NETWORK_MESSAGE, { cause });
    this.name = "NetworkError";
  }
}

/**
 * ¿Es un fallo del que solo se sale reintentando?
 *
 * Junta el fallo de transporte con el 5xx: desde la pantalla los dos se ven
 * igual —no hay datos y lo único que se puede hacer es volver a probar— y, lo
 * que importa aquí, ninguno de los dos dice nada sobre si la sesión es válida.
 * Un 502 de nginx con el backend caído es la misma historia que un túnel.
 */
export function isUnreachable(error: unknown): boolean {
  return (
    error instanceof NetworkError || (error instanceof ApiError && error.status >= 500)
  );
}

export const tokens = {
  access: () => localStorage.getItem(ACCESS_KEY),
  refresh: () => localStorage.getItem(REFRESH_KEY),
  save(pair: TokenPair) {
    localStorage.setItem(ACCESS_KEY, pair.access_token);
    localStorage.setItem(REFRESH_KEY, pair.refresh_token);
  },
  clear() {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

/** Se dispara cuando el refresh falla, para que la app vuelva al login. */
type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler = () => {};
export function setUnauthorizedHandler(handler: UnauthorizedHandler) {
  onUnauthorized = handler;
}

/** Respaldo en español para una respuesta sin cuerpo legible. */
function statusMessage(status: number): string {
  if (status === 400) return "La petición no es válida";
  if (status === 401) return "La sesión ha caducado";
  if (status === 403) return "No tienes permiso para hacer esto";
  if (status === 404) return "No se ha encontrado";
  if (status === 409) return "Ya existe o está en conflicto con algo";
  if (status === 422) return "Hay datos que no son válidos";
  if (status === 429) return "Demasiadas peticiones seguidas. Prueba en unos segundos";
  if (status >= 500) return "El servidor ha fallado. Inténtalo de nuevo";
  return `No se ha podido completar la operación (HTTP ${status})`;
}

async function extractError(response: Response): Promise<string> {
  try {
    const body = await response.json();
    if (typeof body?.detail === "string") return body.detail;
    if (Array.isArray(body?.detail)) {
      return body.detail
        .map((item: { loc?: string[]; msg?: string }) =>
          [item.loc?.slice(1).join("."), item.msg].filter(Boolean).join(": "),
        )
        .join("; ");
    }
    if (typeof body === "string" && body) return body;
    return statusMessage(response.status);
  } catch {
    // Ni cuerpo JSON ni conexión para leerlo. `statusText` es inglés de serie
    // («Internal Server Error»), así que no se usa.
    return statusMessage(response.status);
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  auth?: boolean;
  query?: Record<string, string | number | boolean | null | undefined>;
}

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  const url = `${BASE}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

/**
 * `fetch` con corte, y con todo fallo de transporte convertido en `NetworkError`.
 *
 * `AbortController` a mano y no `AbortSignal.timeout()`: este último llegó en
 * Safari 16 y quien instala esto en un iPhone que se quedó en iOS 15 es
 * justamente quien peor red tiene.
 */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    throw new NetworkError(controller.signal.aborted ? "timeout" : "unreachable", error);
  } finally {
    clearTimeout(timer);
  }
}

async function rawRequest(path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.auth !== false) {
    const access = tokens.access();
    if (access) headers.Authorization = `Bearer ${access}`;
  }

  return fetchWithTimeout(buildUrl(path, options.query), {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

/**
 * Qué ha pasado al intentar renovar.
 *
 * `rejected` es la única de las tres que autoriza a borrar los tokens: el
 * servidor ha mirado el refresh y ha dicho que no. `unreachable` es no saberlo.
 */
type RefreshOutcome = "renewed" | "rejected" | "unreachable";

let refreshInFlight: Promise<RefreshOutcome> | null = null;

async function tryRefresh(): Promise<RefreshOutcome> {
  // Varias peticiones en paralelo comparten un único refresh.
  if (refreshInFlight) return refreshInFlight;

  const refreshToken = tokens.refresh();
  if (!refreshToken) return "rejected";

  refreshInFlight = (async () => {
    try {
      const response = await fetchWithTimeout(buildUrl("/auth/refresh"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      if (response.ok) {
        tokens.save(await readJson<TokenPair>(response));
        return "renewed";
      }
      // Solo un rechazo de autenticación descalifica al token. Un 500 o un 502
      // hablan del servidor, no del refresh, y con ellos la sesión se queda.
      return response.status >= 500 ? "unreachable" : "rejected";
    } catch {
      return "unreachable";
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/**
 * Lee el cuerpo tratando el corte a media respuesta como lo que es: red.
 *
 * Si se dejara escapar, el `TypeError` de WebKit llegaría tal cual a un
 * `Banner` con su «Load failed» dentro.
 */
async function readJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new NetworkError("unreachable", error);
  }
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response = await rawRequest(path, options);

  if (response.status === 401 && options.auth !== false) {
    const outcome = await tryRefresh();
    if (outcome === "renewed") {
      response = await rawRequest(path, options);
      // Un 401 con un token recién renovado ya no es una carrera: el servidor
      // dice que esta sesión no vale. Sin esto se caía al `throw` de abajo con
      // los tokens puestos, y la app se quedaba dentro del armazón de sesión
      // iniciada repitiendo «la sesión ha caducado» sin ruta de vuelta al login.
      if (response.status === 401) {
        tokens.clear();
        onUnauthorized();
        throw new ApiError(401, "La sesión ha caducado. Vuelve a entrar");
      }
    } else if (outcome === "unreachable") {
      // El refresh no ha llegado a contestar: no se sabe si la sesión vale, así
      // que no se toca nada. Se sale por la puerta de la red.
      throw new NetworkError();
    } else {
      tokens.clear();
      onUnauthorized();
      throw new ApiError(401, "La sesión ha caducado. Vuelve a entrar");
    }
  }

  if (!response.ok) throw new ApiError(response.status, await extractError(response));
  if (response.status === 204 || response.headers.get("content-length") === "0") {
    return undefined as T;
  }
  return readJson<T>(response);
}

export const api = {
  get: <T>(path: string, query?: RequestOptions["query"]) => request<T>(path, { query }),
  post: <T>(path: string, body?: unknown, query?: RequestOptions["query"]) =>
    request<T>(path, { method: "POST", body, query }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body }),
  // Con `query` y no con `body`: un DELETE con cuerpo no lo tratan igual todos
  // los intermediarios, y lo que se borra se identifica en la URL.
  delete: <T>(path: string, query?: RequestOptions["query"]) =>
    request<T>(path, { method: "DELETE", query }),
  login: (email: string, password: string) =>
    request<TokenPair>("/auth/login", {
      method: "POST",
      body: { email, password },
      auth: false,
    }),
  register: (email: string, password: string, full_name?: string) =>
    request<unknown>("/auth/register", {
      method: "POST",
      body: { email, password, full_name: full_name || null },
      auth: false,
    }),
};
