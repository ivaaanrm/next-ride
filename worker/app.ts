import { Hono } from "hono";

import type { Auth, SessionUser } from "./auth";
import type { ApiKey } from "./db/schema";
import type { Db } from "./lib/db";

/** Quién está ingestando: una persona con sesión o el servicio scraper. */
export interface IngestPrincipal {
  user: SessionUser | null;
  apiKey: ApiKey | null;
}

export interface AppEnv {
  Bindings: Env;
  Variables: {
    db: Db;
    auth: Auth;
    user: SessionUser;
    principal: IngestPrincipal;
    /**
     * La cuenta en la que se lee y se escribe: la de la sesión, o la dueña de
     * la API key (lo que ingesta el scraper entra en la cuenta de su clave).
     * La fijan las puertas de `middleware.ts`; ver `lib/tenant.ts`.
     */
    tenantId: string;
  };
}

export const router = () => new Hono<AppEnv>();
