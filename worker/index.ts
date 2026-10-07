/**
 * El Worker de next-ride: API (`/api/v1/*`), autenticación (`/api/auth/*`) y
 * health check. La SPA la sirve Workers Static Assets sin pasar por aquí
 * (`assets.run_worker_first` en `wrangler.jsonc`).
 */
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";

import type { AppEnv } from "./app";
import { getAuth } from "./auth";
import { ensureBootstrapped } from "./bootstrap";
import { readSchemaVersion } from "./health";
import { getDb } from "./lib/db";
import { errorResponse } from "./lib/http";
import { analyticsRoutes } from "./routes/analytics";
import { apiKeysRoutes } from "./routes/api-keys";
import { authRoutes } from "./routes/auth";
import { carModelsRoutes } from "./routes/car-models";
import { dealersRoutes } from "./routes/dealers";
import { invitationsRoutes } from "./routes/invitations";
import { offersRoutes } from "./routes/offers";
import { rankingsRoutes } from "./routes/rankings";
import { scoringRoutes } from "./routes/scoring";
import { scrapingRoutes } from "./routes/scraping";
import { statsRoutes } from "./routes/stats";
import { trackingRoutes } from "./routes/tracking";
import { runBackup } from "./services/backup";

export { RankingWorkflow } from "./workflows/ranking";

const app = new Hono<AppEnv>();

app.onError(errorResponse);
app.notFound((c) => c.json({ detail: "Not Found" }, 404));

app.use("*", secureHeaders({ crossOriginResourcePolicy: "same-origin" }));

// Nada de lo que sale de la API se cachea: ni el navegador, ni intermediarios.
// El service worker ya excluye `/api/`; esto cubre todo lo demás.
app.use("/api/*", async (c, next) => {
  await next();
  if (!c.res.headers.has("Cache-Control")) c.res.headers.set("Cache-Control", "no-store");
});

app.use("/api/*", async (c, next) => {
  const db = getDb(c.env);
  const auth = getAuth(c.env, c.req.raw);
  c.set("db", db);
  c.set("auth", auth);
  await ensureBootstrapped(c.env, db, auth);
  await next();
});

app.on(["GET", "POST"], "/api/auth/*", (c) => c.var.auth.handler(c.req.raw));

const v1 = new Hono<AppEnv>();
v1.route("/auth", authRoutes);
v1.route("/api-keys", apiKeysRoutes);
v1.route("/invitations", invitationsRoutes);
v1.route("/dealers", dealersRoutes);
v1.route("/car-models", carModelsRoutes);
v1.route("/tracked-models", trackingRoutes);
v1.route("/scraping", scrapingRoutes);
v1.route("/scoring", scoringRoutes);
v1.route("/offers", offersRoutes);
v1.route("/stats", statsRoutes);
v1.route("/analytics", analyticsRoutes);
v1.route("/", rankingsRoutes);
app.route("/api/v1", v1);

/** Sano = puede servir. Con el esquema desfasado no puede, y lo dice con 503. */
app.get("/health", async (c) => {
  const schema = await readSchemaVersion(c.env.DB);
  const stale = schema.up_to_date === false;
  return c.json(
    {
      status: stale ? "stale_schema" : "ok",
      environment: c.env.ENVIRONMENT,
      ai_enabled: Boolean(c.env.ANTHROPIC_API_KEY),
      schema,
    },
    stale ? 503 : 200,
    { "Cache-Control": "no-store" },
  );
});

export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      runBackup(env, new Date(controller.scheduledTime)).catch((error) => {
        console.error(JSON.stringify({ message: "backup failed", error: String(error) }));
        throw error;
      }),
    );
  },
} satisfies ExportedHandler<Env>;
