/**
 * Backup diario de D1 a R2: una tabla por objeto, NDJSON comprimido.
 *
 * D1 ya trae Time Travel (vuelta atrás a cualquier minuto de los últimos 30
 * días), así que esto no es para el «he borrado algo sin querer» sino para lo
 * que Time Travel no cubre: una copia fuera de la base, legible sin Cloudflare
 * (`zcat tabla.ndjson.gz | jq`) y que sobrevive a que se borre la base entera.
 * Sustituye a los `pg_dump` manuales de `backups/`.
 *
 * Sin sesiones ni verificaciones: caducan solas y restaurarlas resucitaría
 * logins. Con `accounts`, que guarda el hash de las contraseñas: sin él una
 * restauración dejaría a todo el mundo fuera.
 */
const TABLES = [
  "users",
  "accounts",
  "api_keys",
  "dealers",
  "car_models",
  "tracked_models",
  "offers",
  "offer_price_history",
  "offer_favorites",
  "ranking_runs",
  "offer_rankings",
  "score_config",
  "scrape_sources",
  "scrape_targets",
] as const;

const PAGE = 1000;
const PREFIX = "backups";

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

async function dumpTable(d1: D1Database, table: string): Promise<{ ndjson: string; rows: number }> {
  const lines: string[] = [];
  let last = 0;
  for (;;) {
    // Por `rowid` y no por `OFFSET`: cada página es una búsqueda en el índice.
    const { results } = await d1
      .prepare(`SELECT rowid AS __rowid, * FROM ${table} WHERE rowid > ?1 ORDER BY rowid LIMIT ${PAGE}`)
      .bind(last)
      .all<Record<string, unknown> & { __rowid: number }>();
    for (const { __rowid, ...row } of results) {
      lines.push(JSON.stringify(row));
      last = __rowid;
    }
    if (results.length < PAGE) break;
  }
  return { ndjson: lines.join("\n") + (lines.length ? "\n" : ""), rows: lines.length };
}

export async function runBackup(env: Env, now = new Date()): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  const summary: Record<string, number> = {};
  for (const table of TABLES) {
    const { ndjson, rows } = await dumpTable(env.DB, table);
    await env.BUCKET.put(`${PREFIX}/${day}/${table}.ndjson.gz`, await gzip(ndjson), {
      httpMetadata: { contentType: "application/x-ndjson", contentEncoding: "gzip" },
      customMetadata: { rows: String(rows) },
    });
    summary[table] = rows;
  }
  const deleted = await pruneBackups(env.BUCKET, now, Number(env.BACKUP_RETENTION_DAYS) || 30);
  console.log(JSON.stringify({ message: "backup completed", day, rows: summary, deleted }));
}

/** Borra los días que exceden la retención. */
async function pruneBackups(bucket: R2Bucket, now: Date, retentionDays: number): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString().slice(0, 10);
  const stale: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: `${PREFIX}/`, cursor });
    for (const object of page.objects) {
      const day = object.key.split("/")[1] ?? "";
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < cutoff) stale.push(object.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  for (let i = 0; i < stale.length; i += 1000) await bucket.delete(stale.slice(i, i + 1000));
  return stale.length;
}
