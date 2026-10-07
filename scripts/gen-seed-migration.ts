/**
 * Genera `migrations/0001_seed_scraping.sql` desde los valores por defecto de
 * `worker/services/scraping-config.ts`. Se ejecutó una vez; queda por si hay
 * que regenerar la semilla en una base nueva:
 *
 *   node scripts/gen-seed-migration.ts > migrations/0001_seed_scraping.sql
 */
import {
  DEFAULT_SOURCES,
  DEFAULT_TARGETS,
  canonicalMakeModelKey,
} from "../worker/services/scraping-config.ts";

const q = (value: unknown) =>
  value === null || value === undefined ? "NULL" : `'${String(value).replace(/'/g, "''")}'`;

const lines = [
  "-- Fuentes y targets de rastreo por defecto. Después de esto, la API es la autoridad:",
  "-- `INSERT OR IGNORE` no pisa nada que ya exista con la misma clave.",
];
for (const source of DEFAULT_SOURCES) {
  lines.push(
    `INSERT OR IGNORE INTO scrape_sources (key, name, base_url, search_url_template, listing_url, access, notes, config, is_active) VALUES (${[
      source.key,
      source.name,
      source.base_url,
      source.search_url_template,
      source.listing_url,
      source.access,
      source.notes,
      JSON.stringify(source.config),
    ]
      .map(q)
      .join(", ")}, 1);`,
    "--> statement-breakpoint",
  );
}
for (const target of DEFAULT_TARGETS) {
  lines.push(
    `INSERT OR IGNORE INTO scrape_targets (source_id, make_model_key, make, model, max_results, search_url, search_params, is_active) SELECT id, ${[
      canonicalMakeModelKey(target.make, target.model),
      target.make,
      target.model,
    ]
      .map(q)
      .join(", ")}, 15, ${q(target.search_url ?? null)}, ${q(JSON.stringify(target.search_params))}, 1 FROM scrape_sources WHERE key = ${q(target.source_key)};`,
    "--> statement-breakpoint",
  );
}
console.log(lines.join("\n"));
