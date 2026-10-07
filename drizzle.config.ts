import { defineConfig } from "drizzle-kit";

// Solo genera SQL: las migraciones las aplica Wrangler (`d1 migrations apply`),
// que es quien lleva la cuenta en `d1_migrations` y lo que mira `/health`.
export default defineConfig({
  dialect: "sqlite",
  schema: "./worker/db/schema.ts",
  out: "./migrations",
});
