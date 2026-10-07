#!/usr/bin/env node
/**
 * pg-dump-to-d1 — pasa un `pg_dump` (formato plano, con bloques COPY) de la
 * base Postgres anterior a SQL que D1 entiende, más un JSON con los payloads
 * crudos del scraper para subir a R2.
 *
 *   node scripts/pg-dump-to-d1.mjs backups/nextride-XXXX.sql --owner tu@email.com
 *
 * Deja dos ficheros junto al volcado:
 *
 *   <volcado>.d1.sql      → wrangler d1 execute DB --remote --file <volcado>.d1.sql
 *   <volcado>.raw.json    → wrangler r2 object put next-ride/raw/import/<nombre>.raw.json \
 *                             --file <volcado>.raw.json --remote
 *
 * Qué hace con cada cosa:
 *
 * - Usuarios: **no** se importan. Las contraseñas eran bcrypt y Better Auth
 *   usa otro esquema, así que no servirían. Toda referencia a un usuario
 *   (favoritos, seguimientos, quién descartó o editó, quién lanzó un ranking,
 *   quién creó una API key) pasa a la persona de `--owner`, que tiene que
 *   existir ya: entra una vez (o deja que el superusuario se siembre) antes
 *   de importar. next-ride es de una sola persona; si el volcado trae datos de
 *   varias, el script lo avisa.
 * - API keys: se importan con su hash. La `NR_API_KEY` del skill sigue valiendo.
 * - Fuentes y targets de rastreo: sustituyen a la semilla por defecto, porque
 *   los del volcado son los que se han ido ajustando por la API.
 * - El resto del dominio, tal cual, con sus ids (las relaciones se conservan).
 * - `car_models.make_model_key` se calcula aquí, con la misma regla que el Worker.
 * - Fechas a ISO-8601 UTC; booleanos a 0/1; importes a REAL.
 *
 * Sin dependencias: Node 22+.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const args = process.argv.slice(2);
const dumpPath = args.find((arg) => !arg.startsWith("--"));
const ownerIndex = args.indexOf("--owner");
const owner = ownerIndex !== -1 ? args[ownerIndex + 1]?.trim().toLowerCase() : null;

if (!dumpPath || !owner) {
  console.error("Uso: node scripts/pg-dump-to-d1.mjs <volcado.sql> --owner <email>");
  process.exit(1);
}

// --------------------------------------------------------------------------- //
// Lectura de los bloques COPY
// --------------------------------------------------------------------------- //
function unescapeCopy(value) {
  if (value === "\\N") return null;
  return value.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/g, (_, code) => {
    if (code[0] === "x") return String.fromCharCode(parseInt(code.slice(1), 16));
    if (/^[0-7]+$/.test(code)) return String.fromCharCode(parseInt(code, 8));
    return { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" }[code] ?? code;
  });
}

function readTables(text) {
  const tables = new Map();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = /^COPY public\.(\w+) \(([^)]*)\) FROM stdin;$/.exec(lines[i]);
    if (!match) continue;
    const columns = match[2].split(",").map((column) => column.trim().replace(/"/g, ""));
    const rows = [];
    for (i++; i < lines.length && lines[i] !== "\\."; i++) {
      const values = lines[i].split("\t").map(unescapeCopy);
      rows.push(Object.fromEntries(columns.map((column, index) => [column, values[index]])));
    }
    tables.set(match[1], rows);
  }
  return tables;
}

// --------------------------------------------------------------------------- //
// Conversión de valores
// --------------------------------------------------------------------------- //
const iso = (value) => {
  if (value === null) return null;
  const normalized = value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) throw new Error(`Fecha no válida: ${value}`);
  return date.toISOString();
};
const bool = (value) => (value === null ? null : value === "t" ? 1 : 0);
const num = (value) => (value === null ? null : Number(value));
const json = (value) => (value === null ? null : JSON.stringify(JSON.parse(value)));

const OWNER = Symbol("owner");
const q = (value) => {
  if (value === OWNER) return `(SELECT id FROM users WHERE email = '${owner.replace(/'/g, "''")}')`;
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
};

/** Una referencia a usuario del volcado: si había alguien, ahora es el dueño. */
const userRef = (value) => (value === null ? null : OWNER);

function insert(table, rows, mode = "INSERT") {
  if (!rows.length) return [];
  const columns = Object.keys(rows[0]);
  return rows.map(
    (row) => `${mode} INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((c) => q(row[c])).join(", ")});`,
  );
}

// --------------------------------------------------------------------------- //
// Mapeo tabla a tabla
// --------------------------------------------------------------------------- //
const tables = readTables(readFileSync(dumpPath, "utf8"));
const get = (name) => tables.get(name) ?? [];

const legacyUsers = new Map(get("users").map((user) => [user.id, user.email]));
const usersWithData = new Set();
const track = (value) => {
  if (value !== null) usersWithData.add(value);
  return userRef(value);
};

const rawName = `${basename(dumpPath).replace(/\.sql$/, "")}.raw.json`;
const rawKey = `raw/import/${rawName}`;
const raws = [];

const dealers = get("dealers").map((row) => ({
  id: num(row.id),
  slug: row.slug,
  name: row.name,
  website: row.website,
  city: row.city,
  country: row.country,
  rating: num(row.rating),
  is_active: bool(row.is_active),
  notes: row.notes,
  created_at: iso(row.created_at),
  updated_at: iso(row.updated_at),
}));

const carModels = get("car_models").map((row) => ({
  id: num(row.id),
  slug: row.slug,
  make: row.make,
  model: row.model,
  trim: row.trim ?? "",
  make_model_key: `${row.make.toLowerCase()}|${row.model.toLowerCase()}`,
  body_type: row.body_type,
  reference_price: num(row.reference_price),
  is_active: bool(row.is_active),
  created_at: iso(row.created_at),
  updated_at: iso(row.updated_at),
}));

const offers = get("offers").map((row) => {
  let rawRef = null;
  if (row.raw !== null) {
    rawRef = `${rawKey}#${raws.length}`;
    raws.push(JSON.parse(row.raw));
  }
  return {
    id: num(row.id),
    url: row.url,
    external_id: row.external_id,
    source: row.source,
    dealer_id: num(row.dealer_id),
    car_model_id: num(row.car_model_id),
    title: row.title,
    price: num(row.price),
    original_price: num(row.original_price),
    currency: row.currency,
    year: num(row.year),
    mileage_km: num(row.mileage_km),
    power_hp: num(row.power_hp),
    condition: row.condition,
    fuel_type: row.fuel_type,
    transmission: row.transmission,
    location: row.location,
    image_url: row.image_url,
    status: row.status,
    dismissed_at: iso(row.dismissed_at),
    dismissed_by_id: track(row.dismissed_by_id),
    dismiss_reason: row.dismiss_reason,
    first_seen_at: iso(row.first_seen_at),
    last_seen_at: iso(row.last_seen_at),
    manual_fields: row.manual_fields === undefined ? "[]" : json(row.manual_fields) ?? "[]",
    edited_at: row.edited_at === undefined ? null : iso(row.edited_at),
    edited_by_id: row.edited_by_id === undefined ? null : track(row.edited_by_id),
    equipment_rating: num(row.equipment_rating ?? null),
    apparent_condition_rating: num(row.apparent_condition_rating ?? null),
    raw_ref: rawRef,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
});

const history = get("offer_price_history").map((row) => ({
  id: num(row.id),
  offer_id: num(row.offer_id),
  price: num(row.price),
  recorded_at: iso(row.recorded_at),
}));

const favorites = get("offer_favorites").map((row) => ({
  user_id: track(row.user_id),
  offer_id: num(row.offer_id),
  created_at: iso(row.created_at),
}));

const tracked = get("tracked_models").map((row) => ({
  user_id: track(row.user_id),
  car_model_id: num(row.car_model_id),
  target_price: num(row.target_price),
  max_mileage_km: num(row.max_mileage_km),
  min_year: num(row.min_year),
  is_active: bool(row.is_active),
  notes: row.notes,
  created_at: iso(row.created_at),
  updated_at: iso(row.updated_at),
}));

const runs = get("ranking_runs").map((row) => ({
  id: num(row.id),
  make_model_key: row.make_model_key,
  label: row.label ?? "",
  status: row.status,
  triggered_by_id: track(row.triggered_by_id),
  model_used: row.model_used,
  effort: row.effort,
  offers_considered: num(row.offers_considered),
  iterations: num(row.iterations),
  input_tokens: num(row.input_tokens),
  output_tokens: num(row.output_tokens),
  summary: row.summary,
  error: row.error,
  tool_trace: json(row.tool_trace),
  created_at: iso(row.created_at),
  finished_at: iso(row.finished_at),
}));

const rankings = get("offer_rankings").map((row) => ({
  id: num(row.id),
  run_id: num(row.run_id),
  offer_id: num(row.offer_id),
  rank: num(row.rank),
  score: num(row.score),
  verdict: row.verdict,
  reasoning: row.reasoning,
  pros: json(row.pros),
  cons: json(row.cons),
}));

const scoreConfig = get("score_config").map((row) => ({
  id: num(row.id),
  weights: json(row.weights),
  params: json(row.params),
  created_at: iso(row.created_at),
  updated_at: iso(row.updated_at),
}));

const sources = get("scrape_sources").map((row) => ({
  id: num(row.id),
  key: row.key,
  name: row.name,
  base_url: row.base_url,
  search_url_template: row.search_url_template,
  listing_url: row.listing_url,
  access: row.access,
  notes: row.notes,
  config: json(row.config) ?? "{}",
  is_active: bool(row.is_active),
  created_at: iso(row.created_at),
  updated_at: iso(row.updated_at),
}));

const targets = get("scrape_targets").map((row) => ({
  id: num(row.id),
  source_id: num(row.source_id),
  make_model_key: row.make_model_key,
  make: row.make,
  model: row.model,
  max_results: num(row.max_results),
  search_url: row.search_url,
  search_params: json(row.search_params) ?? "{}",
  is_active: bool(row.is_active),
  created_at: iso(row.created_at),
  updated_at: iso(row.updated_at),
}));

const apiKeys = get("api_keys").map((row) => ({
  id: num(row.id),
  name: row.name,
  prefix: row.prefix,
  hashed_key: row.hashed_key,
  is_active: bool(row.is_active),
  last_used_at: iso(row.last_used_at),
  created_by_id: track(row.created_by_id),
  created_at: iso(row.created_at),
  updated_at: iso(row.updated_at),
}));

// --------------------------------------------------------------------------- //
// Salida
// --------------------------------------------------------------------------- //
// D1 no deja crear tablas temporales para comprobarlo antes: si el dueño no
// existe, los favoritos y seguimientos fallan por su NOT NULL y D1 deshace el
// fichero entero, que se ejecuta como una sola transacción.
const ownerCheck = `-- ${owner} tiene que existir antes de importar: entra primero.`;
const sql = [
  `-- Importación de ${basename(dumpPath)} — generado por scripts/pg-dump-to-d1.mjs`,
  ownerCheck,
  "PRAGMA defer_foreign_keys = true;",
  // La semilla de rastreo se sustituye por la configuración real.
  "DELETE FROM scrape_targets;",
  "DELETE FROM scrape_sources;",
  ...insert("dealers", dealers),
  ...insert("car_models", carModels),
  ...insert("offers", offers),
  ...insert("offer_price_history", history),
  ...insert("offer_favorites", favorites, "INSERT OR IGNORE"),
  ...insert("tracked_models", tracked, "INSERT OR IGNORE"),
  ...insert("ranking_runs", runs),
  ...insert("offer_rankings", rankings),
  ...insert("score_config", scoreConfig, "INSERT OR REPLACE"),
  ...insert("scrape_sources", sources),
  ...insert("scrape_targets", targets),
  ...insert("api_keys", apiKeys, "INSERT OR IGNORE"),
].join("\n");

const sqlPath = dumpPath.replace(/\.sql$/, "") + ".d1.sql";
const rawPath = dumpPath.replace(/\.sql$/, "") + ".raw.json";
writeFileSync(sqlPath, sql + "\n");
writeFileSync(rawPath, JSON.stringify(raws));

const counts = {
  dealers: dealers.length,
  car_models: carModels.length,
  offers: offers.length,
  offer_price_history: history.length,
  offer_favorites: favorites.length,
  tracked_models: tracked.length,
  ranking_runs: runs.length,
  offer_rankings: rankings.length,
  scrape_sources: sources.length,
  scrape_targets: targets.length,
  api_keys: apiKeys.length,
  raw_payloads: raws.length,
};
console.log(`SQL → ${sqlPath}`);
console.log(`Crudos → ${rawPath} (súbelo a R2 como ${rawKey})`);
console.table(counts);
if (usersWithData.size > 1) {
  const who = [...usersWithData].map((id) => legacyUsers.get(id) ?? `#${id}`).join(", ");
  console.warn(`Aviso: había datos de ${usersWithData.size} usuarios (${who}); todos pasan a ${owner}.`);
}
