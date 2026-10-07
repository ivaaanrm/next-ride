import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Las pruebas corren dentro de workerd, contra el Worker real (`worker/index.ts`)
// con D1, R2 y el Workflow de Miniflare: extremo a extremo por HTTP, sin dobles
// de nada propio. Solo se sustituye lo externo (la API de Anthropic no se toca:
// sin clave, el ranking responde 503 como en un despliegue sin IA).
export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        main: "./worker/index.ts",
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ENVIRONMENT: "local",
            ALLOW_REGISTRATION: "true",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0000",
            FIRST_SUPERUSER_EMAIL: "admin@next-ride.test",
            FIRST_SUPERUSER_PASSWORD: "changeme123",
            BOOTSTRAP_SCRAPER_API_KEY: "nr_boot0000_bootstrap-secret-for-tests",
            ANTHROPIC_API_KEY: "",
          },
          // Una base aparte para probar una migración sobre datos de antes de
          // ella: la de la app ya está al día cuando arrancan las pruebas.
          d1Databases: ["MIGRATION_DB"],
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/setup.ts"],
    },
  };
});
