/**
 * ¿Está la base al día con las migraciones?
 *
 * Un esquema desfasado no da la cara al arrancar sino en la primera consulta
 * que toque la columna que falta. Por eso `/health` responde 503 si la última
 * migración aplicada (`d1_migrations`, la lleva Wrangler) no es la última del
 * repositorio, embebida en el build.
 *
 * `up_to_date` es `null` cuando no se ha podido averiguar: sin saberlo no se
 * declara caída una app que por lo demás funciona.
 */
const MIGRATIONS = Object.keys(import.meta.glob("../migrations/*.sql", { query: "?raw" }))
  .map((path) => path.split("/").pop()!)
  .sort();

export const HEAD_MIGRATION = MIGRATIONS.at(-1) ?? null;

export interface SchemaVersion {
  current: string | null;
  head: string | null;
  up_to_date: boolean | null;
}

export async function readSchemaVersion(d1: D1Database): Promise<SchemaVersion> {
  try {
    const row = await d1
      .prepare("SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1")
      .first<{ name: string }>();
    const current = row?.name ?? null;
    return { current, head: HEAD_MIGRATION, up_to_date: current === HEAD_MIGRATION };
  } catch (error) {
    // Sin la tabla `d1_migrations` la base no se ha migrado nunca: desfasada.
    if (String(error).includes("no such table")) {
      return { current: null, head: HEAD_MIGRATION, up_to_date: false };
    }
    console.warn(JSON.stringify({ message: "schema version check failed", error: String(error) }));
    return { current: null, head: HEAD_MIGRATION, up_to_date: null };
  }
}
