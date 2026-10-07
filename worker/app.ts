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
  };
}

export const router = () => new Hono<AppEnv>();
