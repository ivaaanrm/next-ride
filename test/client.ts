/**
 * Cliente HTTP de las pruebas: habla con el Worker por `fetch`, como el
 * navegador y como el skill, con cookies de sesión de Better Auth o `X-API-Key`.
 */
import { exports } from "cloudflare:workers";

export const ORIGIN = "http://next-ride.test";

export interface Response<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export class Client {
  cookie = "";
  constructor(readonly apiKey?: string) {}

  async call<T = any>(method: string, path: string, body?: unknown): Promise<Response<T>> {
    const headers: Record<string, string> = { Origin: ORIGIN };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.cookie) headers.Cookie = this.cookie;
    if (this.apiKey) headers["X-API-Key"] = this.apiKey;
    const response = await exports.default.fetch(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    // Las cookies que ponga el servidor se quedan para la siguiente petición.
    const setCookies = response.headers.getSetCookie();
    if (setCookies.length) {
      const jar = new Map(
        this.cookie
          .split("; ")
          .filter(Boolean)
          .map((pair) => [pair.split("=")[0], pair] as const),
      );
      for (const header of setCookies) {
        const pair = header.split(";")[0];
        const [name, value] = pair.split("=");
        if (value) jar.set(name, pair);
        else jar.delete(name);
      }
      this.cookie = [...jar.values()].join("; ");
    }
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // cuerpo no JSON: se devuelve tal cual
    }
    return { status: response.status, body: parsed as T, headers: response.headers };
  }

  get = <T = any>(path: string) => this.call<T>("GET", path);
  post = <T = any>(path: string, body?: unknown) => this.call<T>("POST", path, body);
  put = <T = any>(path: string, body?: unknown) => this.call<T>("PUT", path, body);
  patch = <T = any>(path: string, body?: unknown) => this.call<T>("PATCH", path, body);
  delete = <T = any>(path: string, body?: unknown) => this.call<T>("DELETE", path, body);
}

let counter = 0;
export const unique = (label: string) => `${label}-${Date.now().toString(36)}-${counter++}`;

/** Una persona nueva con sesión abierta (registro por Better Auth). */
export async function signedUpClient(name = "Prueba"): Promise<Client> {
  const client = new Client();
  const email = `${unique("user")}@next-ride.test`;
  const res = await client.post("/api/auth/sign-up/email", {
    email,
    password: "supersecret123",
    name,
  });
  if (res.status !== 200) throw new Error(`sign-up falló: ${res.status} ${JSON.stringify(res.body)}`);
  return client;
}

/**
 * El scraper de una cuenta: una API key suya recién creada. Lo que ingeste
 * entra en la cuenta de `owner`, y solo ella lo ve.
 */
export async function scraperOf(owner: Client): Promise<Client> {
  const res = await owner.post("/api/v1/api-keys", { name: unique("scraper") });
  if (res.status !== 201) throw new Error(`api key falló: ${res.status} ${JSON.stringify(res.body)}`);
  return new Client(res.body.api_key);
}

/** Una cuenta nueva con sesión y su scraper. */
export async function account(name = "Prueba"): Promise<{ user: Client; scraper: Client; id: string }> {
  const user = await signedUpClient(name);
  const [scraper, me] = await Promise.all([scraperOf(user), user.get("/api/v1/auth/me")]);
  return { user, scraper, id: me.body.id as string };
}

export async function adminClient(): Promise<Client> {
  const client = new Client();
  const res = await client.post("/api/auth/sign-in/email", {
    email: "admin@next-ride.test",
    password: "changeme123",
  });
  if (res.status !== 200) throw new Error(`sign-in falló: ${res.status} ${JSON.stringify(res.body)}`);
  return client;
}

export function offerPayload(overrides: Record<string, unknown> = {}) {
  const id = unique("o");
  return {
    url: `https://dealer.example/${id}`,
    title: `Volkswagen Golf 1.5 TSI ${id}`,
    price: 24590,
    original_price: 27990,
    dealer_name: "Smoke Motor",
    dealer_city: "Pamplona",
    dealer_country: "es",
    make: "Volkswagen",
    model: "Golf",
    trim: "1.5 TSI Life",
    year: 2022,
    mileage_km: 31000,
    power_hp: 150,
    condition: "used",
    fuel_type: "petrol",
    transmission: "automatic",
    source: "smoke",
    raw: { id, scraped: true },
    ...overrides,
  };
}
