/**
 * Cliente de la API propia (`/api/v1`).
 *
 * La sesión es una cookie HttpOnly de Better Auth, del mismo origen: el
 * navegador la manda sola y aquí no hay tokens que guardar, adjuntar ni
 * renovar. Antes había un par access/refresh en `localStorage`, y en una PWA
 * instalada en iOS ese almacén se desaloja a los siete días sin visitas.
 */
const BASE = import.meta.env.VITE_API_BASE_URL ?? "/api/v1";

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
 * Un 502 o un 503 con el Worker caído es la misma historia que un túnel.
 */
export function isUnreachable(error: unknown): boolean {
  return (
    error instanceof NetworkError || (error instanceof ApiError && error.status >= 500)
  );
}

/** Se dispara cuando el servidor rechaza la sesión, para que la app vuelva al login. */
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

/**
 * Los códigos de error de Better Auth, en el castellano del resto de la app.
 * Los que no están aquí caen al mensaje genérico del estado HTTP.
 */
const AUTH_MESSAGES: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "Email o contraseña incorrectos",
  INVALID_EMAIL: "El email no es válido",
  INVALID_PASSWORD: "La contraseña no es correcta",
  USER_ALREADY_EXISTS: "Ese email ya está registrado",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "Ese email ya está registrado",
  PASSWORD_TOO_SHORT: "La contraseña debe tener al menos 8 caracteres",
  PASSWORD_TOO_LONG: "La contraseña es demasiado larga",
  EMAIL_PASSWORD_SIGN_UP_DISABLED: "El registro abierto está deshabilitado",
  FAILED_TO_CREATE_USER: "No se ha podido crear la cuenta",
};

export function authErrorMessage(status: number, code?: string, message?: string): string {
  if (code && AUTH_MESSAGES[code]) return AUTH_MESSAGES[code];
  // Los mensajes propios del servidor («Usuario desactivado») ya vienen en castellano.
  if (message && status === 403) return message;
  return statusMessage(status);
}

async function extractError(response: Response): Promise<string> {
  try {
    const body = await response.json();
    if (typeof body?.detail === "string") return body.detail;
    // Better Auth contesta `{message, code}` en lugar de `{detail}`.
    if (typeof body?.code === "string" && AUTH_MESSAGES[body.code]) return AUTH_MESSAGES[body.code];
    if (typeof body?.message === "string" && body.message) return body.message;
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

  return fetchWithTimeout(buildUrl(path, options.query), {
    method: options.method ?? "GET",
    headers,
    // Es el valor por defecto, y se escribe igual: sin la cookie no hay sesión.
    credentials: "same-origin",
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
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
  const response = await rawRequest(path, options);

  // Un 401 es el servidor diciendo que la cookie no vale (caducada, o la sesión
  // se cerró en otro sitio). No hay nada que renovar: se vuelve al login.
  if (response.status === 401 && options.auth !== false) {
    onUnauthorized();
    throw new ApiError(401, "La sesión ha caducado. Vuelve a entrar");
  }

  if (!response.ok) throw new ApiError(response.status, await extractError(response));
  if (response.status === 204 || response.headers.get("content-length") === "0") {
    return undefined as T;
  }
  return readJson<T>(response);
}

export const api = {
  get: <T>(path: string, query?: RequestOptions["query"]) => request<T>(path, { query }),
  /** Como `get`, pero un 401 no cierra la sesión: es para preguntar si la hay. */
  probe: <T>(path: string) => request<T>(path, { auth: false }),
  post: <T>(path: string, body?: unknown, query?: RequestOptions["query"]) =>
    request<T>(path, { method: "POST", body, query }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body }),
  // Con `query` y no con `body`: un DELETE con cuerpo no lo tratan igual todos
  // los intermediarios, y lo que se borra se identifica en la URL.
  delete: <T>(path: string, query?: RequestOptions["query"]) =>
    request<T>(path, { method: "DELETE", query }),
};
