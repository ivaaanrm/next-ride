/**
 * Contraseñas, API keys y comparaciones seguras, todo con Web Crypto.
 *
 * Las contraseñas usan PBKDF2-SHA256 nativo en lugar del scrypt en JavaScript
 * que trae Better Auth por defecto: aquel se come el presupuesto de CPU de una
 * invocación del Worker en cada login. 100.000 iteraciones es el tope que admite
 * workerd para PBKDF2.
 */

const encoder = new TextEncoder();

export const API_KEY_PREFIX = "nr";
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_SCHEME = "pbkdf2_sha256";

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** Comparación en tiempo constante de dos cadenas (vía digest, así iguala longitudes). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(left, right) && a.length === b.length;
}

// --------------------------------------------------------------------------- //
// Contraseñas
// --------------------------------------------------------------------------- //
async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `${PBKDF2_SCHEME}$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

export async function verifyPassword({
  password,
  hash,
}: {
  password: string;
  hash: string;
}): Promise<boolean> {
  const [scheme, iterations, salt, expected] = hash.split("$");
  if (scheme !== PBKDF2_SCHEME || !iterations || !salt || !expected) return false;
  const actual = await pbkdf2(password, fromBase64Url(salt), Number(iterations));
  return safeEqual(toBase64Url(actual), expected);
}

// --------------------------------------------------------------------------- //
// API keys (servicio scraper)
//
// Mismo formato y mismo hash que la API anterior: `nr_<prefijo>_<secreto>` y
// SHA-256 en hexadecimal. Las claves ya repartidas siguen valiendo.
// --------------------------------------------------------------------------- //
export async function hashApiKey(raw: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(raw)));
}

export function apiKeyPrefix(raw: string): string | null {
  const parts = raw.split("_");
  if (parts.length < 3 || parts[0] !== API_KEY_PREFIX) return null;
  return parts[1];
}

/** `(clave_en_claro, prefijo, hash)`. La clave en claro solo se enseña una vez. */
export async function generateApiKey(): Promise<{ raw: string; prefix: string; hashed: string }> {
  const prefix = toHex(randomBytes(4).buffer as ArrayBuffer);
  const raw = `${API_KEY_PREFIX}_${prefix}_${toBase64Url(randomBytes(32))}`;
  return { raw, prefix, hashed: await hashApiKey(raw) };
}

// --------------------------------------------------------------------------- //
// Tokens de un solo uso (invitaciones)
//
// Mismo trato que las API keys: 32 bytes aleatorios en el enlace, SHA-256 en la
// base. Con esa entropía no hace falta un hash lento ni limitar intentos.
// --------------------------------------------------------------------------- //
export async function generateToken(): Promise<{ raw: string; hashed: string }> {
  const raw = toBase64Url(randomBytes(32));
  return { raw, hashed: await hashApiKey(raw) };
}

export const hashToken = hashApiKey;
